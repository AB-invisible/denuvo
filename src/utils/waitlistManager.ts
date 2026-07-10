import prisma from '../lib/prisma';
import { client } from '../client';
import { EmbedBuilder } from 'discord.js';
import { CONFIG } from '../config';
import { refreshAllPanels } from './panelManager';

export async function notifyWaitlist(gameId: number, gameName: string, amount: number) {
  const waitlisted = await prisma.waitlist.findMany({
    where: { gameId },
    orderBy: { createdAt: 'asc' },
    take: amount,
  });

  if (waitlisted.length === 0) return;

  const embed = new EmbedBuilder()
    .setTitle(`🎮 ${CONFIG.NAME} • Waitlist Notification`)
    .setDescription(
      `**${gameName}** is back in stock! You were on the waitlist.\n\n` +
      `Head to the panel and open a ticket now — first come, first served!`
    )
    .setColor(0x57F287)
    .setTimestamp()
    .setFooter({ text: `${CONFIG.NAME} Secure Delivery` });

  const notified: number[] = [];
  for (const entry of waitlisted) {
    try {
      const user = await client.users.fetch(entry.userId).catch(() => null);
      if (user) {
        await user.send({ embeds: [embed] }).catch(() => {});
      }
      notified.push(entry.id);
    } catch {
      notified.push(entry.id);
    }
  }

  if (notified.length > 0) {
    await prisma.waitlist.deleteMany({ where: { id: { in: notified } } });
    await refreshAllPanels();
  }

  console.log(`[Waitlist] Notified ${notified.length}/${waitlisted.length} users for ${gameName}.`);
}
