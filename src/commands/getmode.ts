import prisma from '../lib/prisma';

export async function execute(interaction: any): Promise<void> {
  const gameName = interaction.options.getString('game');

  const modeLabel: Record<string, string> = {
    'gbe': 'GBE Normal',
    'coldloader': 'ColdLoader V2',
    'coldclientloader': 'ColdClientLoader V1',
  };

  if (gameName && gameName.toUpperCase() !== 'ALL') {
    const game = await prisma.game.findUnique({ where: { name: gameName } });
    if (!game) return interaction.editReply({ content: `❌ **Not Found:** Game **${gameName}** does not exist.` });
    const mode = (game as any).generationMode || 'gbe';
    return interaction.editReply({
      content: `🔍 **${gameName}** — generation mode: **${modeLabel[mode] || mode}** (\`${mode}\`)`,
    });
  }

  const games = await prisma.game.findMany({ orderBy: { name: 'asc' } });
  const buckets: Record<string, string[]> = { gbe: [], coldloader: [], coldclientloader: [] };
  for (const g of games) {
    const m = ((g as any).generationMode || 'gbe') as string;
    (buckets[m] ||= []).push(g.name);
  }

  const sections: string[] = [];
  for (const mode of Object.keys(buckets)) {
    const names = buckets[mode];
    if (!names.length) continue;
    const shown = names.slice(0, 15).join(', ');
    const more = names.length > 15 ? ` _+${names.length - 15} more_` : '';
    sections.push(`**${modeLabel[mode] || mode}** (\`${mode}\`) — ${names.length} game(s)\n${shown}${more}`);
  }

  await interaction.editReply({
    content: `🔍 **Generation Mode Summary** (${games.length} total game(s))\n\n${sections.join('\n\n')}`,
  });
}
