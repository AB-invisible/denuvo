import { TextBasedChannel } from 'discord.js';
import { postMainPanel } from '../utils/panelManager';

export async function execute(interaction: any): Promise<void> {
  const channel = interaction.channel;
  if (channel?.isTextBased() && 'send' in channel) {
    await postMainPanel(channel as TextBasedChannel);
    await interaction.editReply({ content: '✅ **Panel posted!** Autorefresh is active.' });
  }
}
