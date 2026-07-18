import {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextChannel,
  User,
  TextBasedChannel,
  GuildMember,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
} from 'discord.js';
import { Game, Ticket, Cooldown, Subscription } from '@prisma/client';
import { CONFIG } from '../config';
import { getActiveGames, REGEN_TIME, processStockCycles, getServerStockMapForGuild } from './gameManager';
import { usesAccountSyncedStock } from './accountCapacity';
import { isUbisoftGame } from './ubisoftCatalog';
import { isEaGame } from './eaCatalog';
import { getEstimatedWaitTime, getStaffStats } from './stats';
import { getActiveStaffCount } from './dutyManager';
import { getPanelAssetUrl } from './downloadHost';
import prisma from '../lib/prisma';

export type GameWithCount = Game & {
  _count?: {
    tickets: number;
  };
};

function truncateDiscordText(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return chars.slice(0, max).join('');
}

/** Count OPEN/CLAIMED tickets per game for this guild only. */
async function getServerReservedMap(guildId: string): Promise<Map<number, number>> {
  const serverCounts = await prisma.ticket.groupBy({
    by: ['gameId'],
    where: { guildId, status: { in: ['OPEN', 'CLAIMED'] } },
    _count: { _all: true },
  });
  return new Map(serverCounts.map((c) => [c.gameId, c._count._all]));
}

function reservedSuffix(reserved: number): string {
  return reserved > 0 ? ` · ${reserved} res` : '';
}

/** Select option text must be plain — emoji in descriptions caused Discord 500s. */
type GameSelectStatusInput = {
  availableStock: number;
  totalStock: number;
  reserved: number;
  queueCount: number;
  now: Date;
  donatorOnly: boolean;
  boosterOnly: boolean;
  highDemand: boolean;
  /** cycleStartedAt + 24h — when this game refills to full. Null = no cycle. */
  nextRestockAt: Date | null;
};

export type GameSelectStatusTone = 'ok' | 'low' | 'out';

/** Plain-text "Restocks in Xh Ym" (select-menu descriptions can't use timestamps). */
function restockPhrase(nextRestockAt: Date | null | undefined, now: Date): string {
  if (!nextRestockAt) return '';
  const remaining = nextRestockAt.getTime() - now.getTime();
  if (remaining <= 60 * 1000) return 'Restocks soon';
  const h = Math.floor(remaining / 3_600_000);
  const m = Math.floor((remaining % 3_600_000) / 60_000);
  return h > 0 ? `Restocks in ${h}h ${m}m` : `Restocks in ${m}m`;
}

function gameSelectStatusTone(input: GameSelectStatusInput): GameSelectStatusTone {
  if (input.availableStock >= 10) return 'ok';
  if (input.availableStock > 0) return 'low';
  return 'out';
}

function formatGameSelectDescription(input: GameSelectStatusInput): string {
  const { availableStock, totalStock, reserved, queueCount, now, nextRestockAt } = input;
  const parts: string[] = [];
  const res = reservedSuffix(reserved);

  if (availableStock >= 10) {
    parts.push(`${availableStock} available${res}`);
  } else if (availableStock > 0) {
    parts.push(`Only ${availableStock} left${res}`);
  } else if (totalStock > 0 && reserved >= totalStock) {
    parts.push(`All ${totalStock} reserved`);
  } else if (totalStock > 0 && reserved > 0) {
    parts.push(`${totalStock} total${res}`);
  } else {
    // Fully out — show when this game's 24h cycle refills it.
    const rp = restockPhrase(nextRestockAt, now);
    if (rp) {
      parts.push(rp + res);
    } else if (reserved > 0) {
      parts.push(`${reserved} in progress`);
    } else {
      parts.push('Out of stock');
    }
  }

  if (queueCount > 0) parts.push(`${queueCount} waiting`);
  if (input.donatorOnly) parts.push('Supporters only');
  else if (input.boosterOnly) parts.push('Boosters only');
  else if (input.highDemand) parts.push('High demand');

  return truncateDiscordText(parts.join(' | '), 100);
}

function buildGameSelectOption(
  game: GameWithCount,
  description: string,
  tone: GameSelectStatusTone,
  reserved: number,
  highDemand = false,
) {
  let statusEmoji = tone === 'ok' ? '🟢' : tone === 'low' ? '🟡' : '🔴';
  // High-demand games fly a 🔥 flag so they stand out — but only while they
  // still have stock; keep 🔴 when out so availability still reads correctly.
  if (highDemand && tone !== 'out') statusEmoji = '🔥';
  const cleanName = game.name.replace(/[^\x20-\x7E]/g, '').trim() || `Game ${game.id}`;
  const resTag = reserved > 0 ? ` [${reserved}r]` : '';
  const safeLabel = truncateDiscordText(`${statusEmoji} ${cleanName}${resTag}`, 100);
  return new StringSelectMenuOptionBuilder()
    .setLabel(safeLabel)
    .setDescription(description)
    .setValue(String(game.id));
}

export async function createMainPanel(
  guildId?: string,
): Promise<{ flags: MessageFlags.IsComponentsV2; components: ContainerBuilder[] }> {
  // Refill anything whose 24h cycle elapsed before we render the counts.
  if (guildId) await processStockCycles(guildId);

  const allGames = await getActiveGames() as GameWithCount[];
  const now = new Date();

  const waitlistCounts = await prisma.waitlist.groupBy({
    by: ['gameId'],
    _count: true,
  });
  const waitlistMap = new Map(waitlistCounts.map(w => [w.gameId, w._count]));

  // Per-server reserved counts: OPEN/CLAIMED tickets holding stock slots
  let serverReservedMap = new Map<number, number>();
  if (guildId) {
    serverReservedMap = await getServerReservedMap(guildId);
  }

  // Per-server stock: each game has its own ServerStock row (incl. Ubisoft/EA).
  let serverStockMap = await getServerStockMapForGuild('__none__');
  if (guildId) {
    serverStockMap = await getServerStockMapForGuild(guildId);
  }

  const totalStock = allGames.reduce((acc: number, game: GameWithCount) => {
    const ss = serverStockMap.get(game.id);
    return acc + (ss ? ss.stock : CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY);
  }, 0);
  const totalReserved = allGames.reduce((acc: number, game: GameWithCount) => {
    return acc + (serverReservedMap.get(game.id) || 0);
  }, 0);
  const totalGames = allGames.length;

  const waitTime = await getEstimatedWaitTime(guildId);
  const staffCount = await getActiveStaffCount();
  const staffLine = staffCount > 0 ? `🟢 **${staffCount}** staff on duty` : '🌙 Staff away — delays likely';
  const cleanWait = waitTime.replace(/[^\x20-\x7E]/g, '');

  // ── Next-restock countdown ──────────────────────────────────────────────
  // Soonest running cycle: whichever game used its first token earliest refills
  // first. Rendered as a Discord relative timestamp so it live-counts-down in
  // every client with no polling on our side.
  const runningCycles = [...serverStockMap.values()]
    .map((s) => s.cycleStartedAt)
    .filter((d): d is Date => d != null)
    .map((d) => d.getTime() + REGEN_TIME);
  const nextRestockLine = runningCycles.length
    ? `<t:${Math.floor(Math.min(...runningCycles) / 1000)}:R>`
    : 'Nothing depleted';

  // ── Build the panel as a Components V2 container ────────────────────────
  // V2 lets us interleave text headers between the platform dropdowns (classic
  // messages can't). A V2 message carries NO embed/content — everything below
  // is components, sent with the IsComponentsV2 flag by panelManager.
  const container = new ContainerBuilder().setAccentColor(0x5865f2);

  const banner = getPanelAssetUrl('gamegen.png');
  if (banner) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(banner)),
    );
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`# ⚡ ${CONFIG.NAME}\n### Game Activation Center`),
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `>>> **📖 Before you start**\n` +
        `▸ Read the setup guide in <#${CONFIG.GUIDE_CHANNEL_ID}>\n` +
        `▸ Make sure your game is **fully installed**`,
    ),
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**🎟️ Getting your token**\n` +
        `▸ Pick your game from the menus below\n` +
        `▸ A **private ticket** opens just for you\n` +
        `▸ Follow the steps in your ticket`,
    ),
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# ⚡ Instant delivery  ·  🛡️ Screenshot verified  ·  🔥 All DLCs included`,
    ),
  );

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# 🎮 **${totalGames}** games  ·  🎫 **${totalStock}** tokens  ·  🔒 **${totalReserved}** reserved  ·  ⏳ Next restock ${nextRestockLine}  ·  ${staffLine}  ·  ⏱️ ${cleanWait}`,
    ),
  );

  if (allGames.length === 0) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('⚠️ **No games are available right now.** Check back soon.'),
    );
    return { flags: MessageFlags.IsComponentsV2, components: [container] };
  }

  // Turn one game into a select option (shared stock/restock formatting).
  const optionForGame = (game: GameWithCount): StringSelectMenuOptionBuilder => {
    const ss = serverStockMap.get(game.id);
    const gameStock = ss ? ss.stock : CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
    const reserved = serverReservedMap.get(game.id) || 0;
    const availableStock = Math.max(0, gameStock - reserved);
    const nextRestockAt = ss?.cycleStartedAt ? new Date(ss.cycleStartedAt.getTime() + REGEN_TIME) : null;

    const statusInput: GameSelectStatusInput = {
      availableStock,
      totalStock: gameStock,
      reserved,
      queueCount: waitlistMap.get(game.id) || 0,
      now,
      donatorOnly: !!game.donatorOnly,
      boosterOnly: !!game.boosterOnly,
      highDemand: !!game.highDemand,
      nextRestockAt,
    };
    return buildGameSelectOption(
      game,
      formatGameSelectDescription(statusInput),
      gameSelectStatusTone(statusInput),
      reserved,
      !!game.highDemand,
    );
  };

  // Add a platform section: a header, then one dropdown per 25 games. Games in
  // each platform are already name-sorted (getActiveGames orders by name).
  const addSection = (header: string, games: GameWithCount[], idPrefix: string, label: string): void => {
    if (games.length === 0) return;
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(header));

    for (let i = 0; i < games.length; i += 25) {
      const chunk = games.slice(i, i + 25);
      const multi = games.length > 25;
      const range = multi ? ` (${chunk[0].name[0].toUpperCase()}–${chunk[chunk.length - 1].name[0].toUpperCase()})` : '';
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`select_game_${idPrefix}_${i}`)
        .setPlaceholder(`${label}${range}`)
        .addOptions(chunk.map(optionForGame));
      container.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
    }
  };

  // Split by platform using the same predicates the rest of the bot uses.
  const ubisoftGames = allGames.filter((g) => isUbisoftGame(g));
  const eaGames = allGames.filter((g) => !isUbisoftGame(g) && isEaGame(g));
  const steamGames = allGames.filter((g) => !isUbisoftGame(g) && !isEaGame(g));

  addSection('### 🎮 Steam Games', steamGames, 'steam', 'Steam Games');
  addSection('### 🟢 EA Games', eaGames, 'ea', 'EA Games');
  addSection('### 🔵 Ubisoft Games', ubisoftGames, 'ubi', 'Ubisoft Games');

  return { flags: MessageFlags.IsComponentsV2, components: [container] };
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
    .setImage(getPanelAssetUrl('maintenance.png') ?? 'attachment://maintenance.png')
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

export function createStaffLookupEmbed(
  targetUser: User,
  history: Ticket[],
  cooldown: Cooldown | null,
  blacklist?: { reason?: string | null; staffId?: string | null; createdAt?: Date } | null,
) {
  const verifiedCount = history.filter(t => t.screenshotVerified).length;
  const totalCount = history.length;
  const failRate = totalCount > 0 ? Math.round(((totalCount - verifiedCount) / totalCount) * 100) : 0;

  const blacklistValue = blacklist
    ? `**YES**${blacklist.reason ? ` — ${blacklist.reason}` : ''}`
    : '`No`';

  const embed = new EmbedBuilder()
    .setTitle(`🔍 Staff Intelligence • ${targetUser.username}`)
    .setDescription(`Comprehensive analytical overview for user **${targetUser.id}**.`)
    .setColor(blacklist || failRate > 50 ? 0xED4245 : 0x57F287)
    .setThumbnail(targetUser.displayAvatarURL())
    .addFields(
      { name: '🆔 User ID', value: `\`${targetUser.id}\``, inline: true },
      { name: '🚫 Denuvo Blacklist', value: blacklistValue, inline: true },
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
    ? link.expiryText.startsWith('Link is permanent')
      ? `1. **[⬇️ Download Token Zip](${link.url})**${sizeNote} — **permanent link** (no expiry, installer re-runnable).`
      : `1. **[⬇️ Download Token Zip](${link.url})**${sizeNote} — link expires in **${link.expiryText.replace(/^Link expires in /i, '')}**.`
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

