import prisma from '../lib/prisma';
import { logAction } from '../utils/logging';

export async function execute(interaction: any): Promise<void> {
  const sub = interaction.options.getSubcommand() as 'all' | 'game';
  const state = interaction.options.getString('state', true);
  const exclude = state === 'on';

  if (sub === 'all') {
    if (exclude) {
      const [updated, deleted] = await prisma.$transaction([
        prisma.game.updateMany({ data: { excludeRegen: true } }),
        prisma.restock.deleteMany({}),
      ]);

      await interaction.editReply({
        content: `🔒 **Bulk Regen Excluded:** Auto-regeneration is now stopped for **${updated.count}** game(s). Cleared **${deleted.count}** pending restock(s).`,
      });

      if (interaction.guild) {
        await logAction(interaction.guild, '🔒 Bulk Regen Excluded',
          `Staff ${interaction.user} stopped automatic stock regeneration for **all ${updated.count} game(s)** and cleared **${deleted.count}** pending restock(s).`,
          0xED4245);
      }
    } else {
      const updated = await prisma.game.updateMany({ data: { excludeRegen: false } });

      await interaction.editReply({
        content: `🔓 **Bulk Regen Enabled:** Auto-regeneration is now enabled for **${updated.count}** game(s).`,
      });

      if (interaction.guild) {
        await logAction(interaction.guild, '🔓 Bulk Regen Enabled',
          `Staff ${interaction.user} enabled automatic stock regeneration for **all ${updated.count} game(s)**.`,
          0x57F287);
      }
    }
    return;
  }

  const gameName = interaction.options.getString('game', true);
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
