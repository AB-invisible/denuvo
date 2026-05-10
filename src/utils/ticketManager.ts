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
import { isStaff, getTier } from './permissions';

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
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const guild = interaction.guild;
    if (!guild) return;

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

      const existingTicket = await tx.ticket.findFirst({
        where: { userId: interaction.user.id, status: { in: ['OPEN', 'CLAIMED'] } }
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
        return { error: '❌ **Resource Exhaustion:** No available tokens at this time. Please monitor restocks.' };
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

    const channel = await guild.channels.create({
      name: channelName,
      parent: CONFIG.TICKET_CATEGORY_ID || null,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        { id: CONFIG.STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      ],
    });

    const ticket = await prisma.ticket.create({
      data: { channelId: channel.id, userId: interaction.user.id, gameId: game.id, status: 'OPEN' },
    });

    const userTier = getTier(interaction.member as GuildMember);
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

    const controlMsg = await channel.send({ content: `<@&${CONFIG.STAFF_ROLE_ID}> New session requested!`, embeds: [embed], components: [row] });

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
    console.error('Error in createTicket:', error);
    await interaction.editReply({ content: `❌ **Denuvo Check Error:** Failed to initialize session.` }).catch(() => {});
  }
}

export async function claimTicket(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  if (!isStaff(interaction.member as GuildMember)) return interaction.followUp({ content: '❌ **Unauthorized:** Staff clearance required.', flags: [MessageFlags.Ephemeral] });


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
  const ticket = await prisma.ticket.findUnique({ where: { channelId: interaction.channelId }, include: { game: true } });
  if (ticket && !ticket.screenshotVerified) {
    const timer = setTimeout(async () => {
      const guild = interaction.guild;
      if (guild) {
        await autoCloseTicketForVerificationTimeout(ticket.channelId, guild);
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
  const ticket = await prisma.ticket.findUnique({ where: { channelId: interaction.channelId } });
  if (!ticket) return interaction.editReply({ content: '❌ Not found.' });

  if (ticket.status === 'CLOSED') {
    return interaction.editReply({ content: '⚠️ **Already Closed:** This session was closed by another process.', components: [] });
  }

  // Bug #10 fix: Safe null handling — don't blindly cast null to GuildMember
  const member = await interaction.guild?.members.fetch(ticket.userId).catch(() => null);
  const userTier = member ? getTier(member) : 'None';
  const maxHours = CONFIG.TIER_COOLDOWNS[userTier.toUpperCase() as keyof typeof CONFIG.TIER_COOLDOWNS] || CONFIG.TIER_COOLDOWNS.DEFAULT;

  const options = [
    { label: '30m', value: '0.5' }, { label: '1h', value: '1' }, { label: '6h', value: '6' }, 
    { label: '12h', value: '12' }, { label: '24h', value: '24' }, { label: '48h', value: '48' }, 
    { label: '1w', value: '168' }, { label: 'Indefinite', value: '8760' }
  ];

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`close_cooldown_select_${choice.toUpperCase()}`)
    .setPlaceholder(`Set Cooldown (${userTier})`)
    .addOptions(options.map(o => new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value)));

  await interaction.editReply({ 
    content: `📊 Deduction: **${choice.toUpperCase()}** • Tier: **${userTier}**`, 
    embeds: [], 
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)] 
  });
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

      setTimeout(() => channel.delete().catch(() => {}), 8000);
    } else {
      const reason = isTimeout ? 'Verification not completed.' : 'Verification failed.';
      await channel.send({ 
        content: `⌛ **Session Expired:** ${reason} Applying a 48-hour cooldown. (Failure count: **${failures}/3**)` 
      }).catch(() => {});

      if (channel.guild) {
        await logAction(channel.guild, '⌛ Session Failed', `Session for <@${userId}> failed in <#${channel.id}>. (Strikes: \`${failures}\`)`, 0xED4245);
      }

      setTimeout(() => channel.delete().catch(() => {}), 5000);
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

