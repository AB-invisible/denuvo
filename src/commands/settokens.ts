import prisma from '../lib/prisma';
import { updateStock } from '../utils/gameManager';
import { refreshAllPanels } from '../utils/panelManager';
import { logAction } from '../utils/logging';

export async function execute(interaction: any): Promise<void> {
  const gameName = interaction.options.getString('game')!;
  const amount = interaction.options.getInteger('amount')!;
  const game = await prisma.game.findUnique({ where: { name: gameName } });
  if (!game) return interaction.editReply({ content: `❌ **Not Found:** Game **${gameName}** does not exist.` });
  await updateStock(gameName, 'set', amount);
  await refreshAllPanels();
  await interaction.editReply({ content: `✅ **Tokens updated:** **${gameName}** now has \`${amount}\` token(s).` });
  if (interaction.guild) {
    await logAction(interaction.guild, '📊 Tokens Set',
      `Staff ${interaction.user} set token count for **${gameName}** to \`${amount}\` (via \`/settokens\`).`,
      0x5865F2);
  }
}
