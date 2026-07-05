import { GuildMember } from 'discord.js';
import { isStaff } from '../utils/permissions';
import { toggleDuty } from '../utils/dutyManager';
import { refreshAllPanels } from '../utils/panelManager';

export async function execute(interaction: any): Promise<void> {
  if (!isStaff(interaction.member as GuildMember)) return interaction.editReply({ content: '❌ **Unauthorized.**' });
  const state = await toggleDuty(interaction.user.id);
  await refreshAllPanels();
  await interaction.editReply({ content: state ? '🟢 **Reporting for Duty:** Active.' : '🌙 **Duty Cycle Ended:** Away.' });
}
