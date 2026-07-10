import { EmbedBuilder } from 'discord.js';
import { client } from '../client';
import prisma from '../lib/prisma';
import { getStaffStats } from '../utils/stats';

export async function execute(interaction: any): Promise<void> {
  const stats = await getStaffStats(interaction.guildId ?? undefined);
  if (stats.length === 0) return interaction.editReply({ content: '📊 **Staff Stats:** No activity recorded.' });

  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  const embed = new EmbedBuilder()
    .setTitle('🏆 Staff performance Leaderboard')
    .setDescription(`Top staff members in the last **7 days**.\n*Resolved since <t:${Math.floor(oneWeekAgo.getTime() / 1000)}:d>.*`)
    .setColor(0x5865F2)
    .setTimestamp();

  let statsList = '';
  for (let i = 0; i < stats.length; i++) {
    const stat = stats[i];
    const user = await client.users.fetch(stat.staffId!).catch(() => null);
    const ticketCount = stat._count?.id ?? 0;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '👤';
    statsList += `${medal} **${user ? user.username : 'Unknown'}**: \`${ticketCount} Tickets\`\n`;
  }

  const nextMeta = await prisma.metadata.findUnique({ where: { key: 'lastWeeklyStatsAt' } });
  const lastDate = nextMeta ? new Date(nextMeta.value) : new Date(0);
  const nextTimestamp = Math.floor((lastDate.getTime() + 7 * 24 * 60 * 60 * 1000) / 1000);

  embed.addFields(
    { name: '📊 Merit Metrics', value: statsList || 'No data.', inline: false },
    { name: '⏱️ Next Cycle', value: `<t:${nextTimestamp}:R>`, inline: true }
  );
  await interaction.editReply({ embeds: [embed] });
}
