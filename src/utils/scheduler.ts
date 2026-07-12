import { Client, TextChannel, EmbedBuilder, Message, GuildMember } from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { getEstimatedWaitTime, getStaffStats } from './stats';
import { checkDutyAutoReset } from './dutyManager';
import { refreshAllPanels } from './panelManager';
import { isStaff } from './permissions';
import { utcDateKey } from './steampassPool';

/**
 * Periodically updates open and claimed ticket embeds with live wait times and durations.
 */
const TICKET_UPDATE_GAP_MS = 350;

export async function updateTicketWaitTimes(client: Client) {
  try {
    const activeTickets = await prisma.ticket.findMany({
      where: { status: { in: ['OPEN', 'CLAIMED'] } },
      select: {
        id: true,
        channelId: true,
        controlMessageId: true,
        status: true,
        claimedAt: true,
        createdAt: true,
        guildId: true,
      },
    });

    if (activeTickets.length === 0) return;

    // Cache the wait estimate per guild for this cycle so a server's tickets
    // show ITS queue (not the global total) without re-querying per ticket.
    const waitByGuild = new Map<string, string>();
    const waitFor = async (gid: string | null): Promise<string> => {
      const key = gid || '';
      if (!waitByGuild.has(key)) waitByGuild.set(key, await getEstimatedWaitTime(gid || undefined));
      return waitByGuild.get(key)!;
    };

    for (const ticket of activeTickets) {
      try {
        const channel = (client.channels.cache.get(ticket.channelId) ??
          await client.channels.fetch(ticket.channelId).catch(() => null)) as TextChannel | null;
        if (!channel) continue;

        let controlMsg: Message | null = null;
        if (ticket.controlMessageId) {
          controlMsg = await channel.messages.fetch(ticket.controlMessageId).catch(() => null);
        }

        // Fallback to searching if ID is missing or message was deleted but channel remains
        if (!controlMsg) {
          const messages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
          if (messages) {
            // Bug #4 fix: Match actual embed title 'Denuvo Check' instead of 'Activation Request'
            controlMsg = messages.find(m => m.author.id === client.user?.id && m.embeds[0]?.title?.includes('Denuvo Check')) || null;
            
            // If we found it, update the ID in DB for future efficiency
            if (controlMsg) {
              await prisma.ticket.update({
                where: { id: ticket.id },
                data: { controlMessageId: controlMsg.id }
              }).catch(() => {});
            }
          }
        }

        if (!controlMsg) continue;

        // Bug #5 fix: Bounds-check embed fields before accessing
        const existingFields = controlMsg.embeds[0]?.fields;
        if (!existingFields || existingFields.length < 6) continue;

        const now = new Date();
        const createdAgo = Math.floor((now.getTime() - ticket.createdAt.getTime()) / 60000);
        
        // Premium Dynamic Display
        let statusString = '';
        let waitDisplay = '';

        if (ticket.status === 'OPEN') {
          statusString = '🟢 **Awaiting Staff Response**';
          waitDisplay = `${await waitFor(ticket.guildId)}\n└─ *Elapsed: ${createdAgo}m*`;
        } else if (ticket.status === 'CLAIMED' && ticket.claimedAt) {
          const claimedAgo = Math.floor((now.getTime() - ticket.claimedAt.getTime()) / 60000);
          statusString = `🟡 **Session Active with Staff** (\`${claimedAgo}m\`)`;
          waitDisplay = `🚀 **Token in Progress**\n└─ *Handling Duration: ${claimedAgo}m*`;
        }

        const embed = EmbedBuilder.from(controlMsg.embeds[0])
          .spliceFields(4, 2, 
            { name: '🕒 Temporal Activity', value: waitDisplay, inline: true },
            { name: '🛰️ Session Status', value: statusString, inline: true }
          );

        // Only edit if content actually changed to save rate limits
        if (existingFields[4].value !== waitDisplay || existingFields[5].value !== statusString) {
          await controlMsg.edit({ embeds: [embed] }).catch(() => {});
        }
      } catch (err) {
        console.error(`[Scheduler] Failed to update ticket ${ticket.id}:`, err);
      }

      await new Promise((r) => setTimeout(r, TICKET_UPDATE_GAP_MS));
    }
  } catch (err) {
    console.error('[Scheduler] Error in ticket update cycle:', err);
  }
}

/**
 * Checks and sends weekly staff statistics. Each authorized server gets
 * its OWN report (scoped to that server's tickets) posted to that server's
 * log channel — home → owner log channel, tenants → their basic log
 * channel. Previously this aggregated every server into one global report
 * posted only to the home channel.
 */
export async function checkWeeklyStaffStats(client: Client) {
  try {
    const meta = await prisma.metadata.findUnique({ where: { key: 'lastWeeklyStatsAt' } });
    const lastAt = meta ? new Date(meta.value) : new Date(0);
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - lastAt.getTime() < oneWeekMs) return;

    const { getAllowedGuildIds, resolveServerConfig } = await import('./tenant');
    let guildIds: string[] = [];
    try { guildIds = await getAllowedGuildIds(); } catch { guildIds = []; }
    if (!guildIds.includes(CONFIG.GUILD_ID)) guildIds.push(CONFIG.GUILD_ID);

    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    let postedAny = false;
    for (const gid of guildIds) {
      try {
        const stats = await getStaffStats(gid);
        if (stats.length === 0) continue;

        const sc = await resolveServerConfig(gid);
        const channelId = sc.isOwner ? sc.ownerLogChannelId : (sc.tenantLogChannelId || sc.ownerLogChannelId);
        if (!channelId) continue;
        const channel = await client.channels.fetch(channelId).catch(() => null) as TextChannel;
        if (!channel) continue;

        const embed = new EmbedBuilder()
          .setTitle('✨ **The High Council - Weekly Enshrinement** ✨')
          .setDescription(`Behold the legendary contributors of the **${sc.botName}** community for the week of <t:${Math.floor(oneWeekAgo.getTime() / 1000)}:d>.\n\n*These sentinels have ensured our tokens are applied and our gates remain secure.*`)
          .setColor(0x00D9FF)
          .setImage('https://i.imgur.com/uR1R6F8.png')
          .setThumbnail('https://cdn-icons-png.flaticon.com/512/3112/3112946.png')
          .setTimestamp()
          .setFooter({ text: `${sc.botName} Epoch System • Automated Meritocratic Sync` });

        let statsList = '';
        for (let i = 0; i < stats.length; i++) {
          const stat = stats[i];
          const user = await client.users.fetch(stat.staffId!).catch(() => null);
          const userName = user ? user.username : 'Shadow User';
          const ticketCount = stat._count?.id ?? 0;
          
          let medal = '💠';
          if (i === 0) medal = '🥇 **Grandmaster**';
          else if (i === 1) medal = '🥈 **Vanguard**';
          else if (i === 2) medal = '🥉 **Sentinel**';

          statsList += `${medal} \u200B **${userName}**\n╰─ \`${ticketCount} Operations Successful\`\n\n`;
        }

        embed.addFields({ name: '📊 Galactic Merit Summary', value: statsList || '*The void remains silent this week.*' });
        
        await channel.send({
          content: '🌌 **ATTENTION SENTINELS: The Weekly Merit Report has arrived!**',
          embeds: [embed]
        }).catch(() => {});
        postedAny = true;
      } catch (e) {
        console.error(`[Scheduler] weekly stats failed for guild ${gid}:`, e);
      }
    }

    // Only advance the weekly gate once we actually posted at least one
    // report — otherwise a fully-idle week just re-checks (harmless).
    if (postedAny) {
      const now = new Date().toISOString();
      await prisma.metadata.upsert({
        where: { key: 'lastWeeklyStatsAt' },
        update: { value: now },
        create: { key: 'lastWeeklyStatsAt', value: now }
      });
    }
  } catch (err) {
    console.error('[Scheduler] Error in weekly stats cycle:', err);
  }
}

/**
 * Automatically resets staff duty after 8 hours.
 */
export async function checkDutyStatusReset() {
  await checkDutyAutoReset();
}

/**
 * Automatically closes tickets with no user/staff activity for 2 hours.
 */
export async function checkStaleTickets(client: Client) {
  try {
    const activeTickets = await prisma.ticket.findMany({
      where: { status: { in: ['OPEN', 'CLAIMED'] } },
      select: {
        id: true,
        channelId: true,
        userId: true,
        guildId: true,
        screenshotVerified: true,
        lastUserActivityAt: true,
      },
    });

    if (activeTickets.length === 0) return;

    const twoHoursMs = 2 * 60 * 60 * 1000;
    const oneDayMs = 24 * 60 * 60 * 1000;
    const fifteenMinsMs = 15 * 60 * 1000;
    const now = new Date();

    for (const ticket of activeTickets) {
      const channel = (client.channels.cache.get(ticket.channelId) ??
        await client.channels.fetch(ticket.channelId).catch(() => null)) as TextChannel | null;
      if (!channel) continue;

      const threshold = ticket.screenshotVerified ? oneDayMs : twoHoursMs;
      const hourDisplay = ticket.screenshotVerified ? '24 hours' : '2 hours';

      // PRE-CHECK: Skip expensive Discord API calls if the database shows recent activity.
      const dbDiff = now.getTime() - ticket.lastUserActivityAt.getTime();
      if (dbDiff < threshold) continue;

      // Fetch more messages to check for overrides and real activity
      const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
      if (!messages) continue;

      // 1. Staff override check
      const hasOverride = messages.some(m => 
        (m.content.toLowerCase().includes('dont auto close') || m.content.toLowerCase().includes('dont close')) && 
        m.member && isStaff(m.member as GuildMember)
      );
      if (hasOverride) continue;

      // Bug #12 fix: Exclude ALL bot messages from "real activity" detection,
      // not just stale alerts. Bot verification prompts, delivery notifications, etc.
      // should not reset the stale timer.
      const lastRealMessage = messages.find(m => m.author.id !== client.user?.id);
      
      if (!lastRealMessage) continue;

      const realDiff = now.getTime() - lastRealMessage.createdAt.getTime();
      
      if (realDiff >= threshold) {
        // Look for any alert sent AFTER the last real activity
        const lastAlert = messages.find(m => 
          m.author.id === client.user?.id && 
          m.content.includes('STALE SESSION ALERT') &&
          m.createdAt.getTime() > lastRealMessage.createdAt.getTime()
        );

        if (!lastAlert) {
          // No alert sent since last activity - send one now
          await channel.send({ 
            content: `🕰️ **STALE SESSION ALERT:** <@${ticket.userId}>, this session has been inactive for **${hourDisplay}**. If no response is received within **15 minutes**, this ticket will be automatically closed to free up resources.` 
          }).catch(() => {});
        } else {
          // Alert exists. Check if 15 mins have passed since that alert message.
          const alertDiff = now.getTime() - lastAlert.createdAt.getTime();
          
          if (alertDiff >= fifteenMinsMs) {
            console.log(`[Scheduler] Closing stale ticket ${ticket.id} (${channel.name})`);
            
            // Bug #13 fix: Apply a 24h cooldown for stale sessions to prevent abandonment spam
            const until = new Date();
            until.setTime(until.getTime() + (24 * 60 * 60 * 1000));
            const staleGuildId = ticket.guildId || channel.guild?.id || '';
            await prisma.cooldown.upsert({
              where: { userId_guildId: { userId: ticket.userId, guildId: staleGuildId } },
              update: { until },
              create: { userId: ticket.userId, guildId: staleGuildId, until }
            });

            await prisma.ticket.update({
              where: { id: ticket.id },
              data: { status: 'CLOSED', closedAt: new Date() }
            });
            const { untrackTicketChannel } = await import('./ticketChannelCache');
            untrackTicketChannel(ticket.channelId);
            
            await channel.send({ 
              content: `🔒 **STALE SESSION TERMINATED:** No activity detected for over **${hourDisplay}**. This session has been closed. Please open a new request if assistance is still required.` 
            }).catch(() => {});
            
            await refreshAllPanels();
            setTimeout(() => channel.delete().catch(() => {}), 5000);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Scheduler] Error in stale ticket cycle:', err);
  }
}

/**
 * Bug #15 fix: Periodically cleans up expired cooldowns from the database.
 */
export async function cleanupExpiredCooldowns() {
  try {
    const result = await prisma.cooldown.deleteMany({
      where: { until: { lt: new Date() } }
    });
    if (result.count > 0) {
      console.log(`[Scheduler] Cleaned up ${result.count} expired cooldown(s).`);
    }

    // New: Check for expired vouches that were missed (e.g., bot was offline)
    const expiredVouches = await prisma.ticket.findMany({
      where: {
        vouchExpiresAt: { lt: new Date() },
        status: { not: 'CLOSED' }
      }
    });

    for (const ticket of expiredVouches) {
      console.log(`[Scheduler] Processing missed vouch timeout for ticket ${ticket.id}`);
      const until = new Date();
      until.setTime(until.getTime() + (48 * 60 * 60 * 1000));
      await prisma.cooldown.upsert({ where: { userId_guildId: { userId: ticket.userId, guildId: ticket.guildId || '' } }, update: { until }, create: { userId: ticket.userId, guildId: ticket.guildId || '', until } });
      
      await prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'CLOSED', vouchExpiresAt: null } });
      const { untrackTicketChannel } = await import('./ticketChannelCache');
      untrackTicketChannel(ticket.channelId);
    }
  } catch (err) {
    console.error('[Scheduler] Error cleaning expired cooldowns:', err);
  }
}

/** Resync owner-server stock when the UTC day rolls over (account quotas reset). */
export async function syncOwnerStockForNewUtcDay() {
  try {
    const today = utcDateKey();
    const meta = await prisma.metadata.findUnique({ where: { key: 'lastOwnerStockSyncDate' } });
    if (meta?.value === today) return;

    const { syncAllOwnerGameStock } = await import('./accountCapacity');
    const { CONFIG } = await import('../config');
    const count = await syncAllOwnerGameStock(CONFIG.OWNER_GUILD_ID, { forceRaise: true });
    await prisma.metadata.upsert({
      where: { key: 'lastOwnerStockSyncDate' },
      update: { value: today },
      create: { key: 'lastOwnerStockSyncDate', value: today },
    });
    console.log(`[Scheduler] Owner stock resynced for new UTC day (${today}) — ${count} game(s).`);
    refreshAllPanels();
  } catch (err) {
    console.error('[Scheduler] Error syncing owner stock for new UTC day:', err);
  }
}
