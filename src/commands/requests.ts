import { EmbedBuilder } from 'discord.js';
import prisma from '../lib/prisma';

export async function execute(interaction: any): Promise<void> {
  const clear = interaction.options.getBoolean('clear');

  if (clear) {
    const count = await prisma.gameRequest.count();
    await prisma.gameRequest.deleteMany();
    return interaction.editReply({ content: `🗑️ Cleared **${count}** game request(s).` });
  }

  const requests = await prisma.gameRequest.groupBy({
    by: ['gameName'],
    _count: { gameName: true },
    orderBy: { _count: { gameName: 'desc' } },
    take: 15,
  });

  if (requests.length === 0) {
    return interaction.editReply({ content: 'ℹ️ No game requests yet. Users can vote with `/request <name>`.' });
  }

  const totalVotes = await prisma.gameRequest.count();
  const totalGames = await prisma.gameRequest.groupBy({ by: ['gameName'] }).then(r => r.length);

  const lines = requests.map((r, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    return `${medal} **${r.gameName}** — ${r._count.gameName} vote${r._count.gameName > 1 ? 's' : ''}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('🗳️ Game Requests')
    .setDescription(lines.join('\n'))
    .addFields(
      { name: 'Total Votes', value: `\`${totalVotes}\``, inline: true },
      { name: 'Unique Games', value: `\`${totalGames}\``, inline: true },
    )
    .setColor(0x5865F2)
    .setTimestamp()
    .setFooter({ text: 'Use /requests clear:True to reset' });

  await interaction.editReply({ embeds: [embed] });
}
