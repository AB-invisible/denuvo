import { 
  TextChannel, 
  PermissionFlagsBits, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  StringSelectMenuInteraction, 
  ButtonInteraction, 
  GuildMember,
  Message,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlags,
  Guild
} from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import fs from 'fs';
import path from 'path';
import { consumeStock } from './gameManager';
import { logAction } from './logging';
import { refreshAllPanels } from './panelManager';
import { createVerificationPromptEmbed, createTicketSuccessEmbed } from './embeds';
import { getEstimatedWaitTime } from './stats';
import { isStaff, getTier, getTierForGuild } from './permissions';
import { resolveServerConfig } from './tenant';

// Note: The Maps below now only store active timers to handle timeouts.
// All stateful metadata (retries, processing, vouches) is persisted in Prisma for durability across reboots.
export const pendingVerificationTimers = new Map<string, NodeJS.Timeout>();
export const vouchTimers = new Map<string, NodeJS.Timeout>(); // userId -> Timeout

let cachedInfo: string | null = null;
let infoCacheTime = 0;
const INFO_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const infoPath = path.join(__dirname, '../../info.md');

async function getInfoContent() {
  const now = Date.now();
  if (cachedInfo && (now - infoCacheTime) < INFO_CACHE_TTL) return cachedInfo;
  try {
    cachedInfo = await fs.promises.readFile(infoPath, 'utf-8');
    infoCacheTime = now;
    return cachedInfo;
  } catch (err) {
    return '📌 **SETUP GUIDE**\n(Failed to read info.md, please ask staff for help)';
  }
}

export async function createTicket(interaction: StringSelectMenuInteraction, gameName: string) {
  try {
    // ─── Replay guard ──────────────────────────────────────────
    // Discord can re-deliver the same interactionCreate event when the
    // bot gateway disconnects + resumes (which happens on every Railway
    // redeploy). The first copy already deferred and created the
    // ticket; the replay would call deferReply again and throw error
    // 40060 ("Interaction has already been acknowledged"), confusing
    // the staff log into thinking the user couldn't open a ticket when
    // they actually did. Skip silently if the interaction is already
    // owned by an earlier handler.
    if (interaction.deferred || interaction.replied) {
      console.warn(`[createTicket] Replay of interaction ${interaction.id} ignored (already acknowledged).`);
      return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const guild = interaction.guild;
    if (!guild) return;

    // ─── Closed-panel / maintenance guard ──────────────────────
    // /closepanel deletes the panel message + the panel DB record, but
    // Discord keeps serving the cached dropdown to clients for up to
    // ~15 minutes. Without this check, a stale dropdown click would
    // create a real ticket against an offline dashboard. Reject early
    // and tell the user the dashboard is closed.
    const [activePanel, activeMaintenance] = await Promise.all([
      prisma.panel.findFirst({ where: { channelId: interaction.channelId } }),
      prisma.maintenance.findFirst({ where: { channelId: interaction.channelId } }),
    ]);
    if (!activePanel || activeMaintenance) {
      return interaction.editReply({
        content:
          '🛠️ **Dashboard Closed:** The activation panel is currently offline for maintenance. '
          + 'Please wait for it to reopen — your click came from a cached dropdown.',
      });
    }

    // ─── Pre-flight orphan cleanup (OUTSIDE the transaction) ──
    // The previous self-heal lived INSIDE the prisma.$transaction
    // below, which was a bad fit: guild.channels.fetch() is a Discord
    // REST call that can take 1–3 s, and Prisma's default transaction
    // timeout is 5 s. On any latency spike the whole transaction
    // (including the orphan close) rolled back and the user stayed
    // stuck. Doing it as a separate non-transactional pair of queries
    // here means the close commits independently — even if it
    // resolves slowly, the create flow that follows is just a fresh
    // transaction.
    const stale = await prisma.ticket.findFirst({
      where: { userId: interaction.user.id, status: { in: ['OPEN', 'CLAIMED'] } },
    });
    if (stale) {
      let channelExists = false;
      try {
        const fetched = await guild.channels.fetch(stale.channelId);
        channelExists = fetched !== null && fetched !== undefined;
      } catch {
        // discord.js throws DiscordAPIError 10003 for unknown channels,
        // or generic ResponseError on timeouts — both → channel gone.
        channelExists = false;
      }

      if (!channelExists) {
        console.warn(`[createTicket] Self-healing orphaned ticket ${stale.id} (channel ${stale.channelId} no longer exists)`);
        await prisma.ticket.update({
          where: { id: stale.id },
          data: { status: 'CLOSED', closedAt: new Date() },
        }).catch((e: Error) => {
          console.error(`[createTicket] Failed to close orphan ticket ${stale.id}:`, e.message);
        });
        // Fall through — user gets a fresh ticket below.
      } else {
        return interaction.editReply({
          content: `❌ **Active Session:** You are already engaged in a session in <#${stale.channelId}>.`,
        });
      }
    }

    // --- ATOMIC TRANSACTION START ---
    const result = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const cooldown = await tx.cooldown.findUnique({ where: { userId: interaction.user.id } });
      if (cooldown && cooldown.until > now) {
        const hoursLeft = (cooldown.until.getTime() - now.getTime()) / (1000 * 60 * 60);

        // Permanent ban detection (anything > 1 week is treated as permanent)
        if (hoursLeft > 168) {
          return { error: `🚨 **Access Revoked:** Your activation privileges have been permanently terminated due to multiple **failed denuvo checks**.` };
        }

        return { error: `❌ **Security Cooldown Active:** Please wait **${Math.ceil(hoursLeft)} hour(s)** before opening a new session.` };
      }

      // We've already handled the orphan-cleanup case above. This is a
      // belt-and-suspenders re-check: if a NEW OPEN ticket appeared in
      // the brief window between the pre-flight and the transaction
      // (very rare — would require two clicks racing), we still bail
      // gracefully instead of overwriting state.
      const existingTicket = await tx.ticket.findFirst({
        where: { userId: interaction.user.id, status: { in: ['OPEN', 'CLAIMED'] } },
      });
      if (existingTicket) {
        return { error: `❌ **Active Session:** You are already engaged in a session in <#${existingTicket.channelId}>.` };
      }

      const game = await tx.game.findUnique({
        where: { name: gameName, disabled: false },
        include: {
          _count: {
            select: {
              tickets: { where: { status: { in: ['OPEN', 'CLAIMED'] } } }
            }
          }
        }
      });

      if (!game) return { error: '❌ **Target Invalid:** The selected game is currently offline or does not exist.' };

      const activeReservations = game._count?.tickets || 0;
      const availableResources = game.stock - activeReservations;

      if (availableResources <= 0) {
        const existing = await tx.waitlist.findUnique({
          where: { userId_gameId: { userId: interaction.user.id, gameId: game.id } },
        });
        if (existing) {
          const position = await tx.waitlist.count({
            where: { gameId: game.id, createdAt: { lte: existing.createdAt } },
          });
          return { error: `⏳ **Out of Stock:** You're already on the waitlist for **${gameName}** at position **#${position}**. You'll be DM'd when it restocks.` };
        }
        await tx.waitlist.create({ data: { userId: interaction.user.id, gameId: game.id } });
        const position = await tx.waitlist.count({ where: { gameId: game.id } });
        return { error: `⏳ **Out of Stock:** You've been added to the waitlist for **${gameName}** at position **#${position}**. You'll receive a DM when it restocks!` };
      }

      if (game.donatorOnly) {
        const member = interaction.member as GuildMember;
        if (!member.roles.cache.has(CONFIG.DONATOR_ROLE_ID)) {
          return { error: `💎 **Tier Restriction:** This game is reserved for **Supporters**.\n🔗 **Upgrade Access:** <${CONFIG.PATREON_URL}>` };
        }
      }

      if (game.boosterOnly) {
        const member = interaction.member as GuildMember;
        if (!member.premiumSince) {
          return { error: `✨ **Booster Exclusive:** This game is currently reserved for **Server Boosters** only.\n\nSupport the server by boosting to unlock access!` };
        }
      }

      return { game };
    });

    if ('error' in result) {
      return interaction.editReply({ content: result.error });
    }

    const { game } = result;
    const channelName = `${gameName.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;

     // Resolve per-server config — buyer servers use their own category /
    // staff role; the home server falls back to the global env values.
    const sc = await resolveServerConfig(guild.id);

    // ─── DEFENSIVE CONFIG VALIDATION ───
    // Verify the configured category exists in this guild. If not (e.g. placeholder ID
    // or wrong server), fall back to creating the channel at root level instead of crashing.
    let parentId: string | null = null;
    if (sc.ticketCategoryId) {
      const cat = await guild.channels.fetch(sc.ticketCategoryId).catch(() => null);
      if (cat && cat.type === 4 /* GuildCategory */) {
        parentId = sc.ticketCategoryId;
      } else {
        console.warn(`[createTicket] ticketCategoryId="${sc.ticketCategoryId}" not a valid category in this guild — creating channel at root.`);
      }
    }

    // Verify staff role exists. If not, skip its permission override (won't crash) and
    // skip the @staff mention later.
    const staffRole = sc.staffRoleId
      ? await guild.roles.fetch(sc.staffRoleId).catch(() => null)
      : null;
    if (sc.staffRoleId && !staffRole) {
      console.warn(`[createTicket] staffRoleId="${sc.staffRoleId}" not found in this guild — staff permissions on the ticket channel will be skipped.`);
    }


    const permissionOverwrites: any[] = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    ];
    if (staffRole) {
      permissionOverwrites.push({
        id: staffRole.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
      });
    }

    const channel = await guild.channels.create({
      name: channelName,
      parent: parentId,
      permissionOverwrites,
    });

    const ticket = await prisma.ticket.create({
      data: { channelId: channel.id, userId: interaction.user.id, gameId: game.id, status: 'OPEN', guildId: interaction.guildId },
    });

    const userTier = await getTierForGuild(interaction.member as GuildMember, guild.id);
    const infoContent = await getInfoContent();
    const waitTime = await getEstimatedWaitTime();

    const embed = new EmbedBuilder()
      .setTitle(`🎫 ${CONFIG.NAME} • Denuvo Check`)
      .setDescription(`Denuvo check initialized for ${interaction.user}.\n\n━━━━━━━━━━━━━━━━━━━━━━\n${infoContent}\n━━━━━━━━━━━━━━━━━━━━━━`)
      .addFields(
        { name: '👤 Requester', value: `${interaction.user}`, inline: true },
        { name: '💎 Membership', value: `\`${userTier}\``, inline: true },
        { name: '🎮 Game', value: `\`${game.name}\``, inline: true },
        { name: '🆔 App ID', value: `\`${game.appId || 'N/A'}\``, inline: true },
        { name: '🕒 Activity Meta', value: `\`${waitTime}\` (ETA: Now)`, inline: true },
        { name: '🛰️ Session Status', value: '🟢 **Awaiting Check**', inline: true }
      )
      .setColor(0x5865F2)
      .setThumbnail('https://cdn-icons-png.flaticon.com/512/3596/3596091.png')
      .setTimestamp()
      .setFooter({ text: `${CONFIG.NAME} • Secure Session ID: ${ticket.id}` });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('claim_ticket').setLabel('Claim Ticket').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('unclaim_ticket').setLabel('Unclaim').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
    );

    const staffMention = staffRole ? `<@&${staffRole.id}> ` : '';
    const controlMsg = await channel.send({ content: `${staffMention}New session requested!`, embeds: [embed], components: [row] });

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { controlMessageId: controlMsg.id }
    });

    await logAction(guild, '🆕 Ticket Initialized', `Session started for **${game.name}**.`, 0x5865F2, [
      { name: '👤 Requester', value: `${interaction.user}`, inline: true },
      { name: '🎮 Game', value: `\`${game.name}\``, inline: true },
      { name: '📂 Channel', value: `${channel}`, inline: true }
    ]);

    const successEmbed = createTicketSuccessEmbed(channel, waitTime);
    await interaction.editReply({ embeds: [successEmbed] });

    // --- Screenshot Verification Timers ---
    const verificationEmbed = createVerificationPromptEmbed(interaction.user);
    await channel.send({ embeds: [verificationEmbed] });

    const timer = setTimeout(async () => {
      await autoCloseTicketForVerificationTimeout(channel.id, guild);
    }, 10 * 60 * 1000);

    // Persist verification state to DB
    await prisma.pendingVerification.create({
      data: {
        ticketId: ticket.id,
        retryCount: 0,
        isProcessing: false
      }
    });

    pendingVerificationTimers.set(channel.id, timer);
    await refreshAllPanels();

  } catch (error) {
    const err = error as Error & { code?: number };
    const detail = err?.message || String(err);

    // Discord error 40060 = "Interaction has already been acknowledged".
    // This is the gateway-replay case (see "Replay guard" above) — the
    // FIRST copy of the interaction succeeded, so there's nothing useful
    // to surface to staff. Don't spam the log channel with these.
    const isReplay = err?.code === 40060 || detail.includes('already been acknowledged');
    if (isReplay) {
      console.warn(`[createTicket] Interaction replay swallowed (40060) for ${interaction.id}.`);
      return;
    }

    console.error('Error in createTicket:', err);

    // Build a useful error message instead of a generic one — helps staff debug
    // config issues without digging through Railway logs.
    let hint = '';
    if (detail.includes('Missing Permissions')) {
      hint = '\n\n*The bot is missing **Manage Channels** or **Manage Roles** permission in this server.*';
    } else if (detail.includes('Unknown Channel') || detail.includes('Invalid Form Body') && detail.includes('parent')) {
      hint = '\n\n*The `TICKET_CATEGORY_ID` env var points at a category that doesn\'t exist in this server.*';
    } else if (detail.includes('Unknown Role')) {
      hint = '\n\n*The `STAFF_ROLE_ID` env var points at a role that doesn\'t exist in this server.*';
    } else if (detail.includes('Maximum number of channels')) {
      hint = '\n\n*This server has reached Discord\'s channel limit (500).*';
    }

    await interaction.editReply({
      content: `❌ **Denuvo Check Error:** Failed to initialize session.\n\`\`\`\n${detail.slice(0, 500)}\n\`\`\`${hint}`
    }).catch(() => {});

    // Also try to log it to the log channel for staff visibility
    try {
      if (interaction.guild) {
        await logAction(interaction.guild, '🚨 Ticket Creation Failed', `User <@${interaction.user.id}> tried to open a ticket for **${gameName}** but it failed:\n\`\`\`\n${detail.slice(0, 800)}\n\`\`\`${hint}`, 0xED4245);
      }
    } catch {}
  }
}

export async function claimTicket(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  if (!isStaff(interaction.member as GuildMember)) return interaction.followUp({ content: '❌ **Unauthorized:** Staff clearance required.', flags: [MessageFlags.Ephemeral] });

  const ticket = await prisma.ticket.findUnique({ where: { channelId: interaction.channelId } });
  if (!ticket || ticket.status !== 'OPEN') {
    return interaction.followUp({ content: '⚠️ **Already Claimed:** This session has already been picked up.', flags: [MessageFlags.Ephemeral] });
  }

  await prisma.ticket.update({
    where: { channelId: interaction.channelId },
    data: { status: 'CLAIMED', staffId: interaction.user.id, claimedAt: new Date() }
  });

  
  const embed = EmbedBuilder.from(interaction.message.embeds[0])
    .setColor(0x57F287)
    .spliceFields(5, 1, { name: '🛰️ Session Status', value: `🟡 **Active with ${interaction.user.username}**`, inline: true });
  
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('claim_ticket').setLabel('Claimed').setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId('unclaim_ticket').setLabel('Unclaim').setStyle(ButtonStyle.Secondary).setDisabled(false),
    new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });

  const guild = interaction.guild;
  if (guild) {
    await logAction(guild, '🛠️ Ticket Claimed', `Staff ${interaction.user} claimed session in <#${interaction.channelId}>.`, 0x57F287);
  }
}

export async function unclaimTicket(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  if (!isStaff(interaction.member as GuildMember)) return interaction.followUp({ content: '❌ **Unauthorized.**', flags: [MessageFlags.Ephemeral] });

  const ticket = await prisma.ticket.findUnique({ where: { channelId: interaction.channelId } });
  if (!ticket || ticket.status !== 'CLAIMED') {
    return interaction.followUp({ content: '⚠️ **Not Claimed:** This session is not currently claimed.', flags: [MessageFlags.Ephemeral] });
  }

  await prisma.ticket.update({
    where: { channelId: interaction.channelId },
    data: { status: 'OPEN', staffId: null, claimedAt: null }
  });

  const embed = EmbedBuilder.from(interaction.message.embeds[0])
    .setColor(0x5865F2)
    .spliceFields(5, 1, { name: '🛰️ Session Status', value: '🟢 **Awaiting Response**', inline: true });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('claim_ticket').setLabel('Claim Ticket').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('unclaim_ticket').setLabel('Unclaim').setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });

  // Reset the verification timer when a ticket is unclaimed
  const freshTicket = await prisma.ticket.findUnique({ where: { channelId: interaction.channelId }, include: { game: true } });
  if (freshTicket && !freshTicket.screenshotVerified) {
    const timer = setTimeout(async () => {
      const guild = interaction.guild;
      if (guild) {
        await autoCloseTicketForVerificationTimeout(freshTicket.channelId, guild);
      }
    }, 10 * 60 * 1000);

    pendingVerificationTimers.set(interaction.channelId, timer);
  }
}

export async function closeTicket(interaction: ButtonInteraction) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  if (!isStaff(interaction.member as GuildMember)) return interaction.editReply({ content: '❌ **Unauthorized.**' });

  // ATOMIC LOCK: Try to claim the closing role
  const isLocked = await prisma.$transaction(async (tx) => {
    const t = await tx.ticket.findUnique({ where: { channelId: interaction.channelId } });
    if (!t || t.activeClosingStaffId) return false;
    await tx.ticket.update({ where: { id: t.id }, data: { activeClosingStaffId: interaction.user.id } });
    return true;
  });

  if (!isLocked) {
    return interaction.editReply({ content: `❌ **Lock Active:** This session is already being finalized.` });
  }

  const updatedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('claim_ticket').setLabel('Claimed').setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId('close_ticket').setLabel(`🔒 Finalizing...`).setStyle(ButtonStyle.Danger).setDisabled(true)
  );

  await interaction.message.edit({ components: [updatedRow] }).catch(() => {});

  const embed = new EmbedBuilder()
    .setTitle('🔒 Token Deduction Protocol')
    .setDescription(`Should one token be deducted for **#${(interaction.channel as TextChannel).name}**?`)
    .setColor(0x2B2D31);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('close_deduct_yes').setLabel('Yes').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('close_deduct_no').setLabel('No').setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

export async function handleDeductionChoice(interaction: ButtonInteraction, choice: 'yes' | 'no') {
  await interaction.deferUpdate();
  const ticket = await prisma.ticket.findUnique({ where: { channelId: interaction.channelId }, include: { game: true } });
  if (!ticket) return interaction.editReply({ content: '❌ Not found.' });

  if (ticket.status === 'CLOSED') {
    return interaction.editReply({ content: '⚠️ **Already Closed:** This session was closed by another process.', components: [] });
  }

  const member = await interaction.guild?.members.fetch(ticket.userId).catch(() => null);
  let userTier: string = member ? await getTierForGuild(member, interaction.guildId!) : 'None';

  const promoTier = await prisma.promoRedemption.findFirst({
    where: { userId: ticket.userId, expiresAt: { gt: new Date() } },
    include: { promo: true },
    orderBy: { expiresAt: 'desc' },
  });
  if (promoTier?.promo.effect === 'temp_tier' && promoTier.promo.tierGrant) {
    const tierRank: Record<string, number> = { Gold: 3, Silver: 2, Bronze: 1, None: 0 };
    if ((tierRank[promoTier.promo.tierGrant] || 0) > (tierRank[userTier] || 0)) {
      userTier = promoTier.promo.tierGrant;
    }
  }

  const hours = CONFIG.TIER_COOLDOWNS[userTier.toUpperCase() as keyof typeof CONFIG.TIER_COOLDOWNS] || CONFIG.TIER_COOLDOWNS.DEFAULT;
  const deduct = choice === 'yes';

  if (deduct) {
    await consumeStock(ticket.gameId).catch(console.error);
  }

  const until = new Date();
  until.setTime(until.getTime() + (hours * 60 * 60 * 1000));
  await prisma.cooldown.upsert({ where: { userId: ticket.userId }, update: { until }, create: { userId: ticket.userId, until } });

  await prisma.ticket.update({
    where: { channelId: interaction.channelId },
    data: { status: 'CLOSED', closedAt: new Date(), screenshotVerified: true, activeClosingStaffId: null },
  });

  const vTimer = pendingVerificationTimers.get(interaction.channelId);
  if (vTimer) {
    clearTimeout(vTimer);
    pendingVerificationTimers.delete(interaction.channelId);
  }

  const vouchTimer = vouchTimers.get(ticket.userId);
  if (vouchTimer) {
    clearTimeout(vouchTimer);
    vouchTimers.delete(ticket.userId);
  }

  const promoNote = promoTier?.promo.effect === 'temp_tier' ? ` (Promo: ${promoTier.promo.tierGrant})` : '';
  await interaction.editReply({ content: `✅ Session closed. Tier: **${userTier}${promoNote}** • Cooldown: **${hours}h**.`, components: [] });

  if (interaction.guild) {
    await logAction(interaction.guild, '🔒 Ticket Closed', `Staff ${interaction.user} closed session in <#${interaction.channelId}>.\n\n**User:** <@${ticket.userId}>\n**Tier:** \`${userTier}${promoNote}\`\n**Cooldown:** \`${hours}h\`\n**Token Deducted:** \`${deduct ? 'YES' : 'NO'}\``, 0x2B2D31);
  }

  await refreshAllPanels();
  setTimeout(() => interaction.channel?.delete().catch(() => {}), 5000);
}

export async function handleCooldownSelection(interaction: StringSelectMenuInteraction) {
  await interaction.deferUpdate();
  const ticket = await prisma.ticket.findFirst({ where: { channelId: interaction.channelId } });
  if (!ticket || ticket.activeClosingStaffId !== interaction.user.id) {
    return interaction.followUp({ content: '❌ **Lock Conflict.**', flags: [MessageFlags.Ephemeral] });
  }

  if (!ticket) return interaction.editReply({ content: '❌ Not found.' });


  const deduct = interaction.customId.endsWith('YES');
  const hours = parseFloat(interaction.values[0]);

  if (deduct) {
    await consumeStock(ticket.gameId).catch(console.error);
  }

  const until = new Date();
  until.setTime(until.getTime() + (hours * 60 * 60 * 1000));
  await prisma.cooldown.upsert({ where: { userId: ticket.userId }, update: { until }, create: { userId: ticket.userId, until } });
  
  await prisma.ticket.update({ 
    where: { channelId: interaction.channelId }, 
    data: { 
      status: 'CLOSED', 
      closedAt: new Date(), 
      screenshotVerified: true,
      activeClosingStaffId: null 
    } 
  });
  
  const vTimer = pendingVerificationTimers.get(interaction.channelId);
  if (vTimer) {
    clearTimeout(vTimer);
    pendingVerificationTimers.delete(interaction.channelId);
  }

  const vouchTimer = vouchTimers.get(ticket.userId);
  if (vouchTimer) {
    const currentTicket = await prisma.ticket.findUnique({ where: { id: ticket.id } });
    // Safety check: ensure we are clearing the correct timer if they have multiple (though shouldn't happen)
    if (currentTicket && currentTicket.vouchChannelMessageId) { 
       clearTimeout(vouchTimer);
       vouchTimers.delete(ticket.userId);
    }
  }
  await interaction.editReply({ content: `✅ Session closed. Cooldown: **${hours}h**.`, components: [] });
  
  if (interaction.guild) {
    await logAction(interaction.guild, '🔒 Ticket Closed (Manual)', `Staff ${interaction.user} manually closed session in <#${interaction.channelId}>.\n\n**User:** <@${ticket.userId}>\n**Cooldown:** \`${hours}h\`\n**Token Deducted:** \`${deduct ? 'YES' : 'NO'}\``, 0x2B2D31);
  }

  await refreshAllPanels();
  setTimeout(() => interaction.channel?.delete().catch(() => {}), 5000);
}

export async function triggerSessionFailure(channelId: string, userId: string, channel: TextChannel | null, isTimeout: boolean = true) {
  const until = new Date();
  until.setTime(until.getTime() + (48 * 60 * 60 * 1000));
  await prisma.cooldown.upsert({ where: { userId }, update: { until }, create: { userId, until } });

  await prisma.ticket.update({ where: { channelId }, data: { status: 'CLOSED', closedAt: new Date() } });

  if (channel) {
    const failures = await prisma.ticket.count({
      where: { userId, status: 'CLOSED', screenshotVerified: false }
    });

    if (failures >= 3) {
      const permanentDate = new Date();
      permanentDate.setFullYear(permanentDate.getFullYear() + 99);
      await prisma.cooldown.upsert({ 
        where: { userId }, 
        update: { until: permanentDate }, 
        create: { userId, until: permanentDate } 
      });

      setTimeout(() => channel.delete().catch(() => {}), 10000);
    } else {
      const reason = isTimeout ? 'Verification not completed.' : 'Verification failed.';
      await channel.send({ 
        content: `⌛ **Session Expired:** ${reason} Applying a 48-hour cooldown. (Failure count: **${failures}/3**)` 
      }).catch(() => {});

      if (channel.guild) {
        await logAction(channel.guild, '⌛ Session Failed', `Session for <@${userId}> failed in <#${channel.id}>. (Strikes: \`${failures}\`)`, 0xED4245);
      }

      setTimeout(() => channel.delete().catch(() => {}), 10000);
    }
  }
}

export async function autoCloseTicketForVerificationTimeout(channelId: string, guild: Guild) {
  try {
    const ticket = await prisma.ticket.findUnique({ where: { channelId } });
    if (!ticket || (ticket.status !== 'OPEN' && ticket.status !== 'CLAIMED')) return;

    const userId = ticket.userId;

    // Bug #1 fix: Check for staff override BEFORE applying any penalties
    const channel = await guild.channels.fetch(channelId).catch(() => null) as TextChannel;
    if (channel) {
      const messages = await channel.messages.fetch({ limit: 20 });
      const hasOverride = messages.some(m => 
        (m.content.toLowerCase().includes('dont close') || m.content.toLowerCase().includes('dont auto close')) && 
        m.member && isStaff(m.member as GuildMember)
      );

      if (hasOverride) {
        console.log(`[AutoClose] Verification timeout suppressed for ${channelId} due to staff override.`);
        return; // No cooldown, no closure — staff said don't close
      }
    }

    await triggerSessionFailure(channelId, userId, channel, true);

    pendingVerificationTimers.delete(channelId);
    await refreshAllPanels();
  } catch (err) {
    console.error(`[AutoClose] Error:`, err);
  }
}

