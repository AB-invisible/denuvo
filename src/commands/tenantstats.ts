import { EmbedBuilder } from 'discord.js';
import prisma from '../lib/prisma';

export async function execute(interaction: any): Promise<void> {
  const guildId = interaction.guildId;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [todayCreated, todayClosed, activeTickets] = await Promise.all([
    prisma.ticket.count({ where: { guildId, createdAt: { gte: todayStart } } }),
    prisma.ticket.count({ where: { guildId, status: 'CLOSED', closedAt: { gte: todayStart } } }),
    prisma.ticket.count({ where: { guildId, status: { in: ['OPEN', 'CLAIMED'] } } }),
  ]);

  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const topGames = await prisma.ticket.groupBy({
    by: ['gameId'],
    where: { guildId, createdAt: { gte: weekAgo } },
    _count: { gameId: true },
    orderBy: { _count: { gameId: 'desc' } },
    take: 5,
  });

  let topGamesText = 'No tickets this week.';
  if (topGames.length > 0) {
    const gameIds = topGames.map(t => t.gameId);
    const games = await prisma.game.findMany({ where: { id: { in: gameIds } } });
    const gameMap = new Map(games.map(g => [g.id, g.name]));
    topGamesText = topGames
      .map((t, i) => `${i + 1}. **${gameMap.get(t.gameId) || 'Unknown'}** — ${t._count.gameId} ticket${t._count.gameId > 1 ? 's' : ''}`)
      .join('\n');
  }

  const totalAllTime = await prisma.ticket.count({ where: { guildId, status: 'CLOSED' } });

  const embed = new EmbedBuilder()
    .setTitle('📊 Server Stats')
    .setDescription(`Usage dashboard for **${interaction.guild?.name || 'this server'}**.`)
    .addFields(
      { name: '📅 Today', value: `Opened: \`${todayCreated}\`\nClosed: \`${todayClosed}\``, inline: true },
      { name: '🎫 Active Tickets', value: `\`${activeTickets}\``, inline: true },
      { name: '📈 All-Time Closed', value: `\`${totalAllTime}\``, inline: true },
      { name: '🔥 Top Games (7d)', value: topGamesText },
    )
    .setColor(0x5865F2)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
