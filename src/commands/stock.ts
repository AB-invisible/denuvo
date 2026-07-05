import { updateStock } from '../utils/gameManager';
import { refreshAllPanels } from '../utils/panelManager';

export async function execute(interaction: any): Promise<void> {
  const sub = interaction.options.getSubcommand() as 'add' | 'remove' | 'set' | 'clear';
  const gameName = interaction.options.getString('game')!;
  const amount = interaction.options.getInteger('amount') || 0;
  await updateStock(gameName, sub, amount);
  await refreshAllPanels();
  await interaction.editReply({ content: `✅ **Systems Sync:** Stock for **${gameName}** updated.` });
}
