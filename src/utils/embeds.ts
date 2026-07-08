import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextChannel, User, TextBasedChannel, GuildMember } from 'discord.js';
import { Game, Ticket, Cooldown, Subscription } from '@prisma/client';
import { CONFIG } from '../config';
import { getActiveGames, REGEN_TIME, processGuildRestocks, getOrCreateServerStock } from './gameManager';
import { getEstimatedWaitTime, getStaffStats } from './stats';
import { getActiveStaffCount } from './dutyManager';
import prisma from '../lib/prisma';

export type GameWithCount = Game & {
  _count?: {
    tickets: number;
  };
};

export async function createMainPanel(guildId?: string) {
  // Process any pending auto-restocks for this server before building panel
  if (guildId) await processGuildRestocks(guildId);

  const allGames = await getActiveGames() as GameWithCount[];
  const now = new Date();

  const waitlistCounts = await prisma.waitlist.groupBy({
    by: ['gameId'],
    _count: true,
  });
  const waitlistMap = new Map(waitlistCounts.map(w => [w.gameId, w._count]));

  // Per-server reserved counts: only count tickets from this server
  let serverReservedMap = new Map<number, number>();
  if (guildId) {
    const serverCounts = await prisma.ticket.groupBy({
      by: ['gameId'],
      where: { guildId, status: { in: ['OPEN', 'CLAIMED'] } },
      _count: true,
    });
    serverReservedMap = new Map(serverCounts.map(c => [c.gameId, c._count]));
  }

  // Per-server stock: fetch all ServerStock entries for this guild
  let serverStockMap = new Map<number, { stock: number; lastDepletedAt: Date | null }>();
  if (guildId) {
    const stocks = await prisma.serverStock.findMany({ where: { guildId } });
    serverStockMap = new Map(stocks.map(s => [s.gameId, { stock: s.stock, lastDepletedAt: s.lastDepletedAt }]));
  }

  const totalStock = allGames.reduce((acc: number, game: GameWithCount) => {
    const ss = serverStockMap.get(game.id);
    return acc + (ss ? ss.stock : 5);
  }, 0);
  const totalReserved = allGames.reduce((acc: number, game: GameWithCount) => {
    return acc + (serverReservedMap.get(game.id) || 0);
  }, 0);
  const totalGames = allGames.length;

  const waitTime = await getEstimatedWaitTime();
  const mainEmbed = new EmbedBuilder()
    .setTitle(`👑 ${CONFIG.NAME} • Gateway Selection 👑`)
    .setDescription(`Welcome to the **${CONFIG.NAME} Activation Lounge**.\nChoose your desired game below to initiate the secure token request process.\n\n💎 **Membership Perks:** [Get Better Perks Here](<${CONFIG.PATREON_URL}>)`)

    .addFields(
      { name: '📊 Statistics', value: `\`\`\`yaml\nTokens:    ${totalStock}\nReserved:  ${totalReserved}\nGames:     ${totalGames}\nWait Time: ${waitTime.replace(/[^\x20-\x7E]/g, '')}\n\`\`\``, inline: true },
      { name: '🕒 Automatic Reset', value: 'Depleted games automatically restore **5 tokens** every **24 hours**.', inline: true },
      { name: '🛰️ Staff Availability', value: await (async () => { const count = await getActiveStaffCount(); return count > 0 ? `🟢 **${count} Staff Active**` : '🌙 **Staff Away** (Delays Expected)'; })(), inline: true },
      { name: '━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
      { name: '💎 Status Indicators', value: '🟢 **Optimal** (10+ Tokens)\n🟡 **Low Stock** (<10 Tokens)\n🔴 **Empty** (Waiting for Regen)', inline: false }
    )
    .setColor(0x5865F2)
    .setImage('attachment://gamegen.png')
    .setTimestamp()
    .setFooter({ text: `${CONFIG.NAME} Management • Premium Experience • ${new Date().toLocaleDateString()}` });

  if (allGames.length === 0) {
    mainEmbed.setDescription(`Welcome to the **${CONFIG.NAME} Activation Lounge**.\n\n⚠️ **No games are currently available in the system.**\nIf you are an administrator, please run the seed script to populate the database.`);
    return { embeds: [mainEmbed], components: [] };
  }

  // Create Select Menus
  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  const chunkSize = 25;

  for (let i = 0; i < allGames.length; i += chunkSize) {
    const chunk = allGames.slice(i, i + chunkSize);
    const firstGame = chunk[0];
    const lastGame = chunk[chunk.length - 1];
    const startLetter = firstGame.name[0].toUpperCase();
    const endLetter = lastGame.name[0].toUpperCase();

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`select_game_${i}`)
      .setPlaceholder(`🎮 Browse Games [${startLetter}-${endLetter}]`)
      .addOptions(
        chunk.map((game: GameWithCount) => {
          const ss = serverStockMap.get(game.id);
          const gameStock = ss ? ss.stock : 5;
          const gameLastDepleted = ss ? ss.lastDepletedAt : null;
          const reserved = serverReservedMap.get(game.id) || 0;
          const availableStock = Math.max(0, gameStock - reserved);
          const queueCount = waitlistMap.get(game.id) || 0;

          let emoji = '🔴';
          let description = `ID: ${game.appId || 'N/A'} • ${availableStock} tokens remaining (${reserved} reserved)`;

          if (availableStock >= 10) emoji = '🟢';
          else if (availableStock > 0) emoji = '🟡';
          else if (availableStock === 0 && gameLastDepleted) {
            const timeDiff = now.getTime() - gameLastDepleted.getTime();
            const remaining = Math.max(0, REGEN_TIME - timeDiff);
            const hours = Math.floor(remaining / (1000 * 60 * 60));
            const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
            const queueText = queueCount > 0 ? ` • ${queueCount} in queue` : '';
            description = `ID: ${game.appId || 'N/A'} • 🔄 Restock in ${hours}h ${minutes}m${queueText}`;
          } else if (availableStock === 0 && reserved > 0) {
            emoji = '🔴';
            const queueText = queueCount > 0 ? ` • ${queueCount} in queue` : '';
            description = `ID: ${game.appId || 'N/A'} • ⏳ Out of stock (${reserved} reserved${queueText})`;
          }

          if (game.donatorOnly) {
            emoji = '💎';
            description = `💎 Donator Only (2h cd) • ${description}`;
          } else if (game.boosterOnly) {
            emoji = '✨';
            description = `✨ Booster Only • ${description}`;
          } else if (game.highDemand) {
            if (availableStock > 0) emoji = '🔥';
            description = `🔥 High Demand (48h cd) • ${description}`;
          }

          return new StringSelectMenuOptionBuilder()
            .setLabel(game.name)
            .setDescription(description.substring(0, 100))
            .setValue(game.name)
            .setEmoji(emoji);
        })
      );

    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }

  return { embeds: [mainEmbed], components: rows };
}

export async function createMaintenancePanel(durationMinutes?: number | null) {
  let estimatedDuration = 'Unknown';

  if (durationMinutes && durationMinutes > 0) {
    const endTimestamp = Math.floor((Date.now() + durationMinutes * 60 * 1000) / 1000);
    estimatedDuration = `<t:${endTimestamp}:R>`;
  }

  const maintenanceEmbed = new EmbedBuilder()
    .setTitle(`⚠️ ${CONFIG.NAME} • Under Maintenance ⚠️`)
    .setDescription(`Our **${CONFIG.NAME} Activation Lounge** is currently undergoing scheduled maintenance.\nNo new token requests can be processed at this time.`)
    .addFields(
      { name: '🕒 Estimated Duration', value: estimatedDuration, inline: true },
      { name: '🔧 Support', value: 'Please contact a staff member if you have an urgent request.', inline: true },
      { name: '━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
    )
    .setColor(0xED4245) // Danger Red
    .setImage('attachment://maintenance.png')
    .setTimestamp()
    .setFooter({ text: `${CONFIG.NAME} Management • Maintenance Mode • ${new Date().toLocaleDateString()}` });

  return { embeds: [maintenanceEmbed], components: [] };
}

export function createVerificationPromptEmbed(user: User | string) {
  return new EmbedBuilder()
    .setTitle(`🛡️ ${CONFIG.NAME} • Denuvo Check`)
    .setDescription(`Verification required: User ${user}. Upload a single screenshot containing:`)
    .addFields(
      { name: '1️⃣ File Explorer', value: 'Must show the game directory (path ending in `steamapps/common/GameName`).', inline: false },
      { name: '2️⃣ Windows Update Blocker', value: 'Must show WUB with "Disable Updates" selected.', inline: false },
      { name: '3️⃣ Properties Window', value: 'Show either the Game Folder properties or the .exe properties.', inline: false },
      { name: '━━━━━━━━━━━━', value: ' ', inline: false },
      { name: '⏱️ Time Limit', value: '10 Minutes', inline: true },
      { name: '🛑 Penalty', value: '48h Cooldown', inline: true }
    )
    .setColor(0xFEE75C) // Yellow for warning/pending
    .setTimestamp()
    .setFooter({ text: `${CONFIG.NAME} Security • All 3 windows must be visible simultaneously.` });
}


export function createVerificationProcessingEmbed() {
  return new EmbedBuilder()
    .setTitle(`🔍 ${CONFIG.NAME} • Analyzing Assets`)
    .setDescription('Analyzing uploaded screenshot for authenticity and folder compliance.')
    .setColor(0x5865F2) // Blurple
    .setFooter({ text: 'Executing Advanced Denuvo Analysis...' });
}

export function createVerificationSuccessEmbed() {
  return new EmbedBuilder()
    .setTitle(`✅ ${CONFIG.NAME} • Verification Successful`)
    .setDescription('Verification complete. Security clearance granted. Process handed over to staff.')
    .setColor(0x57F287) // Success Green
    .setTimestamp()
    .setFooter({ text: 'Security cleared via Automated Verification' });
}

export function createVerificationFailureEmbed(remainingRetries: number, reasoning?: string) {
  const embed = new EmbedBuilder()
    .setTitle(`❌ ${CONFIG.NAME} • Verification Warning`)
    .setColor(0xED4245); // Danger Red

  if (remainingRetries > 0) {
    embed.setDescription(`Verification failed. Incorrect screenshot detected. Retry required.`)
         .addFields(
           { name: '🔄 Remaining Attempts', value: `\`${remainingRetries} / 3\``, inline: true }
         );
    
    if (reasoning) {
      embed.addFields({ name: '📝 AI Feedback', value: `\`${reasoning}\``, inline: false });
    }

    embed.setFooter({ text: 'Ensure the game directory is clearly visible.' });
  } else {
    embed.setTitle(`🚫 ${CONFIG.NAME} • Access Terminated`)
         .setDescription(`Maximum retry attempts exceeded. Verification session terminated.`)
         .addFields({ name: '⏳ Cooldown Applied', value: '`48 Hours`', inline: true })
         .setFooter({ text: 'Denuvo Check: 3-Strike Rule' });
  }

  return embed;
}


export function createTicketSuccessEmbed(channel: TextBasedChannel | string, waitTime: string) {
  return new EmbedBuilder()
    .setTitle(`✅ ${CONFIG.NAME} • Ticket Initialized`)
    .setDescription(`Session initialized in channel: ${channel}. Awaiting **denuvo check** completion.`)
    .addFields(
      { name: '🕒 Est. Wait Time', value: `\`${waitTime}\``, inline: true }
    )
    .setColor(0x57F287) // Success Green
    .setFooter({ text: 'Denuvo Check Initialized' });
}

// Bug #9 fix: Accept GuildMember for accurate joinedAt date instead of User.createdAt
export function createProfileEmbed(user: User, cooldown: Cooldown | null, subscriptions: (Subscription & { game: { name: string } })[], totalActivations: number, member?: GuildMember | null, trustInfo?: { score: number, rank: string } | null) {
  const hasActiveCooldown = cooldown && cooldown.until > new Date();
  const cooldownDisplay = hasActiveCooldown
    ? `Expires <t:${Math.floor(cooldown.until.getTime() / 1000)}:R>`
    : 'None (Cleared)';

  // Use member.joinedAt for server join date, fallback to user.createdAt (account creation)
  const joinTimestamp = member?.joinedAt?.getTime() || user.createdAt?.getTime() || 0;

  const embed = new EmbedBuilder()
    .setTitle(`👤 User Security Profile • ${user.username}`)
    .setThumbnail(user.displayAvatarURL())
    .setColor(hasActiveCooldown ? 0xED4245 : 0x5865F2)
    .addFields(
      { name: '🛡️ Active Cooldown', value: `\`${cooldownDisplay}\``, inline: true },
      { name: '📊 Total Activations', value: `\`${totalActivations}\``, inline: true },
      { name: '📅 Joined Server', value: `<t:${Math.floor(joinTimestamp / 1000)}:R>`, inline: true },
      { name: '⭐ Trust Score', value: trustInfo ? `\`${trustInfo.score}\` (${trustInfo.rank})` : '`N/A`', inline: true },
      { name: '━━━━━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false }
    );

  const subList = subscriptions.length > 0 
    ? subscriptions.map(s => `• ${s.game.name}`).join('\n') 
    : '`No active subscriptions`';

  embed.addFields({ name: '🔔 Restock Notifications', value: subList, inline: false });

  return embed;
}

export function createStaffLookupEmbed(targetUser: User, history: Ticket[], cooldown: Cooldown | null) {
  const verifiedCount = history.filter(t => t.screenshotVerified).length;
  const totalCount = history.length;
  const failRate = totalCount > 0 ? Math.round(((totalCount - verifiedCount) / totalCount) * 100) : 0;

  const embed = new EmbedBuilder()
    .setTitle(`🔍 Staff Intelligence • ${targetUser.username}`)
    .setDescription(`Comprehensive analytical overview for user **${targetUser.id}**.`)
    .setColor(failRate > 50 ? 0xED4245 : 0x57F287)
    .setThumbnail(targetUser.displayAvatarURL())
    .addFields(
      { name: '🆔 User ID', value: `\`${targetUser.id}\``, inline: true },
      { name: '🛡️ Cooldown', value: cooldown && cooldown.until > new Date() ? `\`${cooldown.until.toLocaleString()}\`` : '`None`', inline: true },
      { name: '📈 AI Verify Success', value: `\`${verifiedCount}/${totalCount}\` (${100 - failRate}%)`, inline: true },
      { name: '📝 Recent Sessions', value: history.length > 0 ? history.map(t => `<#${t.channelId}> (${t.status})`).join('\n') : 'No history found.', inline: false }
    )
    .setTimestamp();

  return embed;
}

export interface TokenDeliveryLinkInfo {
  /** Self-hosted download URL (https://<bot>/download/<token>) */
  url: string;
  /** Human-readable expiry hint, e.g. "30 minutes — download soon" */
  expiryText: string;
  /** Zip size for the user-facing hint, e.g. "9.0" */
  sizeMB?: string;
}

/**
 * Universal token-delivery embed used by /test, /tokengen and the
 * auto-gen flow. Pass `link` for hosted zips (the normal path now —
 * direct Discord attachment of the zip is no longer used). Without a
 * link the embed still works for the rare offline-attach fallback.
 */
export function createTokenDeliveryEmbed(
  gameName: string,
  userId: string,
  staffUser: User,
  link?: TokenDeliveryLinkInfo,
) {
  // Sanitize for the filename hint (mirrors headless_token.py's safe_basename
  // logic) so the user sees the exact name of the installer .exe in the zip.
  const safeName = gameName.replace(/[<>:"/\\|?*]/g, '').trim() || 'Game';
  const sizeNote = link?.sizeMB ? ` _(~${link.sizeMB} MB)_` : '';

  // Step 1 changes depending on whether we have a download link. Keep
  // the rest of the copy identical so the user experience is uniform.
  const step1 = link
    ? `1. **[⬇️ Download Token Zip](${link.url})**${sizeNote} — link expires in **${link.expiryText.replace(/^Link expires in /i, '')}**.`
    : `1. Download the **.zip** attached above.`;

  return new EmbedBuilder()
    .setTitle(`📦 ${CONFIG.NAME} • Token Delivery`)
    .setDescription(
      `<@${userId}>, your activation token for **${gameName}** is ready!\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🚨 **READ THIS FIRST — OR YOU WILL DELETE YOUR GAME**\n` +
      `**DO NOT extract this zip into your game folder.**\n` +
      `Extract to your **Desktop** or **Downloads** — somewhere SEPARATE from the game.\n` +
      `The installer finds your game on its own. If you extract on top of the game folder,\n` +
      `the installer's cleanup step will wipe your game files when it finishes.\n\n` +
      `❌ \`...\\SteamLibrary\\steamapps\\common\\${safeName}\\...\`  ← **NEVER**\n` +
      `✅ \`...\\Desktop\\Token [${safeName}]\\...\`  ← **do this**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🚀 **HOW TO ACTIVATE — 3 STEPS**\n` +
      `${step1}\n` +
      `2. Right-click the zip → **Extract All...** and pick a folder on your **Desktop**.\n` +
      `   **NOT inside your game folder.** Anywhere else is fine.\n` +
      `3. Open that new folder and double-click **\`Install ${safeName}.exe\`** — approve UAC.\n\n` +
      `**What happens next:**\n` +
      `• The installer finds your game on Steam automatically and deploys the activation files.\n` +
      `• When it's done you'll see a confirmation popup with the exact thing to launch — ` +
      `usually a desktop shortcut with your game's own icon, or just the Steam library button.\n\n` +
      `🎮 **${gameName} must already be installed via Steam first.**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━`
    )
    .addFields(
      { name: '👤 Requester', value: `<@${userId}>`, inline: true },
      { name: '🛠️ Activator', value: `${staffUser}`, inline: true },
      { name: '📋 Next Step', value: 'Run the installer, then come back and click **Yes** or **No** below to let us know if the game works.', inline: false }
    )
    .setColor(0x5865F2)
    .setTimestamp();
}

export function createVouchRequestEmbed(vouchChannelId: string, staffId: string, botId: string) {
  return new EmbedBuilder()
    .setTitle(`⭐ ${CONFIG.NAME} • Vouch Required`)
    .setDescription(`Great to hear it works! To finalize your session, please post a vouch in <#${vouchChannelId}> within **10 minutes**.`)
    .addFields(
      { name: '📝 Requirements', value: `1. Screenshot of the game working\n2. Mention the staff: <@${staffId}>\n3. Mention the bot: <@${botId}>`, inline: false },
      { name: '⏱️ Deadline', value: '`10 Minutes`', inline: true },
      { name: '🚫 Penalty', value: '`48-Hour Cooldown`', inline: true }
    )
    .setColor(0xFEE75C)
    .setTimestamp()
    .setFooter({ text: 'Failure to vouch will result in an automated security cooldown.' });
}

