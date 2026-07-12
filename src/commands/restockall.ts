import prisma from '../lib/prisma';
import { refreshAllPanels } from '../utils/panelManager';
import { logAction } from '../utils/logging';
import { resolveOwnerManualStock } from '../utils/accountCapacity';

export async function execute(interaction: any): Promise<void> {
  const amount = interaction.options.getInteger('amount') ?? 5;
  const guildId = interaction.guildId || '';

  const games = await prisma.game.findMany({ where: { disabled: false } });
  if (games.length === 0) {
    return interaction.editReply({ content: '❌ No active games found.' });
  }

  for (const game of games) {
    const stock = await resolveOwnerManualStock(game.id, guildId, amount);
    await prisma.serverStock.upsert({
      where: { gameId_guildId: { gameId: game.id, guildId } },
      update: { stock, lastDepletedAt: null },
      create: { gameId: game.id, guildId, stock },
    });
  }

  await prisma.restock.deleteMany({ where: { guildId } });
  await refreshAllPanels();

  await interaction.editReply({
    content: `✅ **Restocked All:** Set \`${games.length}\` game(s) to at least \`${amount}\` token(s) (account-linked games may be higher). Cleared pending restocks.`,
  });

  if (interaction.guild) {
    await logAction(interaction.guild, '📦 Restock All',
      `Staff ${interaction.user} set all ${games.length} game(s) to \`${amount}\` tokens.`,
      0x57F287);
  }
}
