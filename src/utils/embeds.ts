import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextChannel, User, TextBasedChannel, GuildMember } from 'discord.js';
import { Game, Ticket, Cooldown, Subscription } from '@prisma/client';
import { CONFIG } from '../config';
import { getActiveGames, REGEN_TIME } from './gameManager';
import { getEstimatedWaitTime, getStaffStats } from './stats';
import { getActiveStaffCount } from './dutyManager';

export type GameWithCount = Game & {
  _count?: {
    tickets: number;
  };
};

export async function createMainPanel() {
  const allGames = await getActiveGames() as GameWithCount[];
  const now = new Date();

  const totalStock = allGames.reduce((acc: number, game: GameWithCount) => acc + game.stock, 0);
  const totalReserved = allGames.reduce((acc: number, game: GameWithCount) => acc + (game._count?.tickets || 0), 0);
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
    .setColor(0x5865F2) // Blurple
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
          const reserved = game._count?.tickets || 0;
          const availableStock = Math.max(0, game.stock - reserved);
          
          let emoji = '🔴';
          let description = `ID: ${game.appId || 'N/A'} • ${availableStock} tokens remaining (${reserved} reserved)`;

          if (availableStock >= 10) emoji = '🟢';
          else if (availableStock > 0) emoji = '🟡';
          else if (availableStock === 0 && game.lastDepletedAt) {
            const timeDiff = now.getTime() - game.lastDepletedAt.getTime();
            const remaining = Math.max(0, REGEN_TIME - timeDiff);
            const hours = Math.floor(remaining / (1000 * 60 * 60));
            const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
            description = `ID: ${game.appId || 'N/A'} • 🔄 Full Restock in ${hours}h ${minutes}m (${reserved} reserved)`;
          } else if (availableStock === 0 && reserved > 0) {
            emoji = '🔴';
            description = `ID: ${game.appId || 'N/A'} • ⏳ Out of stock (${reserved} reserved)`;
          }

          if (game.donatorOnly) {
            emoji = '💎';
            description = `💎 Donator Only • ${description}`;
          }

          if (game.boosterOnly) {
            emoji = '✨';
            description = `✨ Booster Only • ${description}`;
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
export function createProfileEmbed(user: User, cooldown: Cooldown | null, subscriptions: (Subscription & { game: { name: string } })[], totalActivations: number, member?: GuildMember | null) {
  const timeLeft = cooldown && cooldown.until > new Date() 
    ? Math.ceil((cooldown.until.getTime() - Date.now()) / (1000 * 60 * 60)) 
    : 0;

  // Use member.joinedAt for server join date, fallback to user.createdAt (account creation)
  const joinTimestamp = member?.joinedAt?.getTime() || user.createdAt?.getTime() || 0;

  const embed = new EmbedBuilder()
    .setTitle(`👤 User Security Profile • ${user.username}`)
    .setThumbnail(user.displayAvatarURL())
    .setColor(timeLeft > 0 ? 0xED4245 : 0x5865F2)
    .addFields(
      { name: '🛡️ Active Cooldown', value: timeLeft > 0 ? `\`${timeLeft} Hours Remaining\`` : '`None (Cleared)`', inline: true },
      { name: '📊 Total Activations', value: `\`${totalActivations}\``, inline: true },
      { name: '📅 Joined Server', value: `<t:${Math.floor(joinTimestamp / 1000)}:R>`, inline: true },
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

export function createTokenDeliveryEmbed(gameName: string, userId: string, staffUser: User) {
  return new EmbedBuilder()
    .setTitle(`📦 ${CONFIG.NAME} • Token Delivery`)
    .setDescription(`<@${userId}>, your activation token for **${gameName}** is ready!\n\n━━━━━━━━━━━━━━━━━━━━━━\n⚠️ **CRITICAL INSTRUCTIONS**\n1. Check the file **above** for your specific token.\n2. **NEVER** launch the game from Steam.\n3. Always use the **.exe** located in your game folder.\n━━━━━━━━━━━━━━━━━━━━━━`)
    .addFields(
      { name: '👤 Requester', value: `<@${userId}>`, inline: true },
      { name: '🛠️ Activator', value: `${staffUser}`, inline: true },
      { name: '📋 Next Step', value: 'Please confirm if the game works using the buttons below.', inline: false }
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

