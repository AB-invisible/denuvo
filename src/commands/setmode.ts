import prisma from '../lib/prisma';
import { logAction } from '../utils/logging';

export async function execute(interaction: any): Promise<void> {
  const gameName = interaction.options.getString('game')!;
  const mode = interaction.options.getString('mode')!;

  const modeLabel: Record<string, string> = {
    'gbe': 'GBE Normal (flat: steam_api64 + steamclient64 + steam_settings)',
    'coldloader': 'ColdLoader V2 (DLL hijack)',
    'coldclientloader': 'ColdClientLoader V1 (launcher .exe)',
  };

  if (gameName.toUpperCase() === 'ALL') {
    const before = await prisma.game.groupBy({
      by: ['generationMode'] as any,
      _count: { _all: true },
    } as any) as Array<{ generationMode: string, _count: { _all: number } }>;

    const result = await prisma.game.updateMany({ data: { generationMode: mode } as any });

    const summary = before
      .map(b => `\`${b.generationMode || 'gbe'}\` → ${b._count._all}`)
      .join(', ') || '(no rows)';

    await interaction.editReply({
      content:
        `✅ **Bulk Mode Update:** Set **${result.count}** game(s) to **${modeLabel[mode] || mode}**.\n` +
        `*(Previous distribution: ${summary})*\n\n` +
        `Next ticket opened for any game will use the new mode.`,
    });

    if (interaction.guild) {
      await logAction(interaction.guild, '⚙️ Bulk Mode Change',
        `Staff ${interaction.user} switched **all ${result.count} game(s)** to \`${mode}\`. Previous distribution: ${summary}.`,
        0x5865F2);
    }
    return;
  }

  const game = await prisma.game.findUnique({ where: { name: gameName } });
  if (!game) return interaction.editReply({ content: `❌ **Not Found:** Game **${gameName}** does not exist. (Use \`ALL\` to bulk-apply to every game.)` });

  const oldMode = (game as any).generationMode || 'gbe';
  await prisma.game.update({ where: { id: game.id }, data: { generationMode: mode } as any });

  await interaction.editReply({
    content: `✅ **Mode Updated:** **${gameName}** will now generate tokens using **${modeLabel[mode] || mode}**.\n*(Previously: \`${oldMode}\`)*\n\nNext ticket opened for this game will use the new mode.`
  });

  if (interaction.guild) {
    await logAction(interaction.guild, '⚙️ Generation Mode Changed', `Staff ${interaction.user} switched **${gameName}** from \`${oldMode}\` to \`${mode}\`.`, 0x5865F2);
  }
}
