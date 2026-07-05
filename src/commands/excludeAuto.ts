import prisma from '../lib/prisma';
import { refreshAllPanels } from '../utils/panelManager';
import { logAction } from '../utils/logging';

export async function execute(interaction: any): Promise<void> {
  const gameName = interaction.options.getString('game')!;
  const state = interaction.options.getString('state')!;
  const exclude = state === 'on';

  const game = await prisma.game.findUnique({ where: { name: gameName } });
  if (!game) return interaction.editReply({ content: `❌ **Not Found:** Game **${gameName}** does not exist.` });

  await prisma.game.update({ where: { id: game.id }, data: { excludeRegen: exclude } });

  if (exclude) {
    const deleted = await prisma.restock.deleteMany({ where: { gameId: game.id } });
    if (deleted.count > 0) {
      await interaction.editReply({ content: `🔒 **Regen Excluded:** **${gameName}** will no longer auto-regenerate stock. Cleared **${deleted.count}** pending restock(s).` });
    } else {
      await interaction.editReply({ content: `🔒 **Regen Excluded:** **${gameName}** will no longer auto-regenerate stock.` });
    }
  } else {
    await interaction.editReply({ content: `🔓 **Regen Enabled:** **${gameName}** will now auto-regenerate stock as normal.` });
  }
}
