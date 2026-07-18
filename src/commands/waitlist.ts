import { EmbedBuilder, GuildMember } from 'discord.js';
import prisma from '../lib/prisma';
import { refreshAllPanels } from '../utils/panelManager';

export async function execute(interaction: any): Promise<void> {
  const leaveGame = interaction.options.getString('leave');

  if (leaveGame) {
    const game = await prisma.game.findUnique({ where: { name: leaveGame } });
    if (!game) {
      return interaction.editReply({ content: `❌ Game **${leaveGame}** not found.` });
    }

    const entry = await prisma.waitlist.findUnique({
      where: { userId_gameId: { userId: interaction.user.id, gameId: game.id } },
    });
    if (!entry) {
      return interaction.editReply({ content: `ℹ️ You're not on the waitlist for **${leaveGame}**.` });
    }

    await prisma.waitlist.delete({ where: { id: entry.id } });
    await refreshAllPanels();
    return interaction.editReply({ content: `✅ Removed from the **${leaveGame}** waitlist.` });
  }

  const entries = await prisma.waitlist.findMany({
    where: { userId: interaction.user.id },
    include: { game: true },
    orderBy: { createdAt: 'asc' },
  });

  if (entries.length === 0) {
    return interaction.editReply({
      content: 'ℹ️ You\'re not on any waitlists. When a game is out of stock, you\'ll be offered to join its queue.',
    });
  }

  const member = interaction.member as GuildMember;
  const guildId = interaction.guildId;
  let isGold = false;
  if (member && guildId) {
    const { getTierForGuild } = await import('../utils/permissions');
    const userTier = await getTierForGuild(member, guildId);
    isGold = userTier === 'Gold';
  }

  const lines = await Promise.all(entries.map(async (e) => {
    if (isGold) {
      const oldestEntry = await prisma.waitlist.findFirst({
        where: { gameId: e.gameId, NOT: { userId: interaction.user.id } },
        orderBy: { createdAt: 'asc' },
      });
      if (oldestEntry && e.createdAt > oldestEntry.createdAt) {
        const newCreatedAt = new Date(oldestEntry.createdAt.getTime() - 1000);
        await prisma.waitlist.update({
          where: { id: e.id },
          data: { createdAt: newCreatedAt },
        });
        e.createdAt = newCreatedAt;
      }
    }
    const position = await prisma.waitlist.count({
      where: { gameId: e.gameId, createdAt: { lte: e.createdAt } },
    });
    return `**${e.game.name}** — #${position} in queue (joined <t:${Math.floor(e.createdAt.getTime() / 1000)}:R>)`;
  }));

  const embed = new EmbedBuilder()
    .setTitle('📋 Your Waitlists')
    .setDescription(lines.join('\n'))
    .setColor(0x5865F2)
    .setFooter({ text: 'Use /waitlist leave:<game> to leave • /queue list for all queues' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
