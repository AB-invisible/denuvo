import prisma from '../lib/prisma';
import { client } from '../client';
import { EmbedBuilder } from 'discord.js';
import { CONFIG } from '../config';
import { refreshAllPanels } from './panelManager';
import {
  getQueuePosition,
  queueNotifyCount,
  QUEUE_RESERVE_RATIO,
  computeSlotSplit,
} from './queueManager';

/**
 * Notify queued users when total stock increases their queue-pool capacity.
 */
export async function notifyWaitlist(
  gameId: number,
  gameName: string,
  previousStock: number,
  newStock: number,
) {
  const notifyCount = queueNotifyCount(previousStock, newStock);
  if (notifyCount <= 0) return;

  const waitlisted = await prisma.waitlist.findMany({
    where: { gameId },
    orderBy: { createdAt: 'asc' },
    take: notifyCount,
  });

  if (waitlisted.length === 0) return;

  const { generalCapacity, queueCapacity } = computeSlotSplit(newStock);
  const generalPct = Math.round((1 - QUEUE_RESERVE_RATIO) * 100);
  const queuePct = Math.round(QUEUE_RESERVE_RATIO * 100);

  let notified = 0;
  for (const entry of waitlisted) {
    const position = await getQueuePosition(entry.userId, gameId);
    const embed = new EmbedBuilder()
      .setTitle(`🎮 ${CONFIG.NAME} • Queue Slot Available`)
      .setDescription(
        `**${gameName}** is back in stock (**${newStock}** total → **${generalCapacity}** general + **${queueCapacity}** queue).\n\n` +
        `A **queue slot** (${queuePct}% of stock) is reserved for you at position **#${position}**.\n\n` +
        `Head to the panel and open a ticket. Queue slots are FIFO. ` +
        `**${generalPct}%** of tokens stay open to everyone.\n\n` +
        `💎 **Gold** members can bypass queue limits.`,
      )
      .setColor(0x57F287)
      .setTimestamp()
      .setFooter({ text: `${CONFIG.NAME} Secure Delivery` });

    try {
      const user = await client.users.fetch(entry.userId).catch(() => null);
      if (user) {
        await user.send({ embeds: [embed] }).catch(() => {});
      }
      await prisma.waitlist.update({
        where: { id: entry.id },
        data: { notifiedAt: new Date() },
      });
      notified++;
    } catch {
      // Keep entry on waitlist even if DM fails
    }
  }

  if (notified > 0) {
    await refreshAllPanels();
  }

  console.log(`[Waitlist] Notified ${notified}/${waitlisted.length} queued users for ${gameName}.`);
}
