import prisma from '../lib/prisma';
import { updateStock, updateStockForAllGames } from '../utils/gameManager';
import { refreshAllPanels } from '../utils/panelManager';
import { logAction } from '../utils/logging';

export async function execute(interaction: any): Promise<void> {
  const gameName = interaction.options.getString('game')!;
  const amount = interaction.options.getInteger('amount')!;
  const guildId = interaction.guildId || '';

  if (gameName.toUpperCase() === 'ALL') {
    const result = await updateStockForAllGames(amount, guildId);
    await refreshAllPanels();
    let content = `✅ **Bulk tokens set:** \`${result.count}\` game(s) now have \`${amount}\` token(s).`;
    if (result.restocksCleared > 0) {
      content += ` Cleared \`${result.restocksCleared}\` pending restock(s).`;
    }
    if (result.notified > 0) {
      content += ` DM'd subscribers/queue for \`${result.notified}\` game(s) with increased stock.`;
    }
    await interaction.editReply({ content });
    if (interaction.guild) {
      await logAction(
        interaction.guild,
        '📊 Bulk Tokens Set',
        `Staff ${interaction.user} set every game token count to \`${amount}\` via \`/settokens ALL\` (${result.count} game(s) updated${result.restocksCleared > 0 ? `, ${result.restocksCleared} pending restock(s) cleared` : ''}).`,
        0x5865F2
      );
    }
    return;
  }

  const game = await prisma.game.findUnique({ where: { name: gameName } });
  if (!game) return interaction.editReply({ content: `❌ **Not Found:** Game **${gameName}** does not exist. (Use \`ALL\` to bulk-apply to every game.)` });
  await updateStock(gameName, 'set', amount, guildId);
  await refreshAllPanels();
  await interaction.editReply({ content: `✅ **Tokens updated:** **${gameName}** now has \`${amount}\` token(s).` });
  if (interaction.guild) {
    await logAction(interaction.guild, '📊 Tokens Set',
      `Staff ${interaction.user} set token count for **${gameName}** to \`${amount}\` (via \`/settokens\`).`,
      0x5865F2);
  }
}
