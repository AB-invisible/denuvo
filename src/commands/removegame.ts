import prisma from '../lib/prisma';
import { purgeGameCascade } from '../utils/gameManager';
import { refreshAllPanels } from '../utils/panelManager';
import { logAction } from '../utils/logging';

export async function execute(interaction: any): Promise<void> {
  const gameName = interaction.options.getString('game')!;
  const game = await prisma.game.findUnique({ where: { name: gameName } });
  if (!game) return interaction.editReply({ content: `❌ **Not Found:** **${gameName}** doesn't exist.` });
  if (!(game as any).manuallyAdded) {
    return interaction.editReply({
      content: `❌ **Cannot Remove:** **${gameName}** comes from \`denuvo.json\` — it's not safe to delete here because the next sync would re-create it.\n` +
        `*To remove it permanently, edit \`denuvo.json\` and remove its entry. Or use \`/game state game:${gameName} state:off\` to just hide it.*`
    });
  }
  const activeTickets = await prisma.ticket.count({
    where: { gameId: game.id, status: { in: ['OPEN', 'CLAIMED'] } }
  });
  if (activeTickets > 0) {
    return interaction.editReply({
      content: `❌ **Cannot Remove:** **${gameName}** has ${activeTickets} active ticket(s). Close them first.`
    });
  }
  await purgeGameCascade(game.id);
  await refreshAllPanels();
  await interaction.editReply({ content: `🗑️ **Removed:** **${gameName}** has been deleted from the panel.` });
  if (interaction.guild) {
    await logAction(interaction.guild, '🗑️ Game Removed',
      `Staff ${interaction.user} permanently removed manually-added game **${gameName}** (AppID \`${game.appId}\`) via \`/removegame\`.`,
      0xED4245);
  }
}
