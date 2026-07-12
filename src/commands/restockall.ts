import prisma from '../lib/prisma';
import { refreshAllPanels } from '../utils/panelManager';
import { logAction } from '../utils/logging';
import { resolveOwnerManualStock } from '../utils/accountCapacity';
import { notifyStockRestocked } from '../utils/gameManager';

export async function execute(interaction: any): Promise<void> {
  const amount = interaction.options.getInteger('amount') ?? 5;
  const guildId = interaction.guildId || '';

  const games = await prisma.game.findMany({ where: { disabled: false } });
  if (games.length === 0) {
    return interaction.editReply({ content: '❌ No active games found.' });
  }

  let notified = 0;
  for (const game of games) {
    const existing = await prisma.serverStock.findUnique({
      where: { gameId_guildId: { gameId: game.id, guildId } },
    });
    const previousStock = existing?.stock ?? 0;
    const stock = await resolveOwnerManualStock(game.id, guildId, amount);

    await prisma.serverStock.upsert({
      where: { gameId_guildId: { gameId: game.id, guildId } },
      update: { stock, lastDepletedAt: null },
      create: { gameId: game.id, guildId, stock },
    });

    if (stock > previousStock) {
      await notifyStockRestocked(game.id, game.name, previousStock, stock);
      notified++;
    }
  }

  await prisma.restock.deleteMany({ where: { guildId } });
  await refreshAllPanels();

  let content = `✅ **Restocked All:** Set \`${games.length}\` game(s) to at least \`${amount}\` token(s) (account-linked games may be higher). Cleared pending restocks.`;
  if (notified > 0) {
    content += ` Notified subscribers/queue for \`${notified}\` game(s) with increased stock.`;
  }
  await interaction.editReply({ content });

  if (interaction.guild) {
    await logAction(interaction.guild, '📦 Restock All',
      `Staff ${interaction.user} set all ${games.length} game(s) to \`${amount}\` tokens.`,
      0x57F287);
  }
}
