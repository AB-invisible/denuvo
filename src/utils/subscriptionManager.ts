import prisma from '../lib/prisma';
import { client } from '../client';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { CONFIG } from '../config';

export async function addSubscription(userId: string, gameId: number): Promise<{ success: boolean; message: string }> {
  try {
    const existing = await prisma.subscription.findUnique({
      where: {
        userId_gameId: { userId, gameId }
      }
    });

    if (existing) {
      return { success: false, message: 'You are already subscribed to restock notifications for this game.' };
    }

    await prisma.subscription.create({
      data: { userId, gameId }
    });

    return { success: true, message: '✅ **Notification Set:** You will receive a DM once tokens are restocked.' };
  } catch (error) {
    console.error('[Subscription] Error adding subscription:', error);
    return { success: false, message: '❌ Failed to set subscription.' };
  }
}

export async function notifySubscribers(gameId: number, gameName: string, amount: number) {
  const subscribers = await prisma.subscription.findMany({
    where: { gameId }
  });

  if (subscribers.length === 0) return;

  const embed = new EmbedBuilder()
    .setTitle(`🔔 ${CONFIG.NAME} • Stock Restocked!`)
    .setDescription(`Great news! **${gameName}** has just received a fresh supply of tokens.`)
    .addFields(
      { name: '🎮 Game', value: `\`${gameName}\``, inline: true },
      { name: '📦 New Stock', value: `\`+${amount} Tokens\``, inline: true }
    )
    .setColor(0x57F287) // Success Green
    .setTimestamp()
    .setFooter({ text: `${CONFIG.NAME} Secure Delivery` });

  const batchSize = 10;
  for (let i = 0; i < subscribers.length; i += batchSize) {
    const batch = subscribers.slice(i, i + batchSize);
    await Promise.allSettled(
      batch.map(async (sub) => {
        try {
          const user = await client.users.fetch(sub.userId).catch(() => null);
          if (user) {
            await user.send({ embeds: [embed] }).catch(() => {
              console.warn(`[Subscription] Failed to DM user ${sub.userId} (DMs closed?)`);
            });
          }
        } catch (err) {
          console.error(`[Subscription] Error notifying user ${sub.userId}:`, err);
        }
      })
    );
  }

  // Clear subscriptions after notification
  await prisma.subscription.deleteMany({
    where: { gameId }
  });

  console.log(`[Subscription] Notified ${subscribers.length} users for ${gameName}.`);
}

export async function getUserSubscriptions(userId: string) {
  return await prisma.subscription.findMany({
    where: { userId },
    include: { game: true }
  });
}
