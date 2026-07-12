import { addToBlacklist, removeFromBlacklist } from '../utils/blacklistManager';
import { logAction } from '../utils/logging';

export async function execute(interaction: any): Promise<void> {
  const sub = interaction.options.getSubcommand() as 'add' | 'remove';
  const user = interaction.options.getUser('user', true);
  const guildId = interaction.guildId || '';
  const reason = interaction.options.getString('reason');

  if (user.bot) {
    return interaction.editReply({ content: '❌ Bots cannot be blacklisted.' });
  }

  if (sub === 'add') {
    const { created } = await addToBlacklist(user.id, guildId, interaction.user.id, reason);
    const reasonLine = reason?.trim() ? `\n**Reason:** ${reason.trim()}` : '';

    await interaction.editReply({
      content: created
        ? `🚫 **Blacklisted:** ${user} can no longer open Denuvo activation tickets on this server.${reasonLine}`
        : `🚫 **Blacklist updated:** ${user} was already blacklisted — reason/staff record refreshed.${reasonLine}`,
    });

    if (interaction.guild) {
      await logAction(
        interaction.guild,
        '🚫 Denuvo Blacklist',
        `Staff ${interaction.user} blacklisted ${user} from opening Denuvo tickets.${reasonLine}`,
        0xED4245,
      );
    }
    return;
  }

  const removed = await removeFromBlacklist(user.id, guildId);
  if (!removed) {
    return interaction.editReply({
      content: `ℹ️ ${user} is not on the Denuvo ticket blacklist for this server.`,
    });
  }

  await interaction.editReply({
    content: `✅ **Blacklist removed:** ${user} can open Denuvo activation tickets again on this server.`,
  });

  if (interaction.guild) {
    await logAction(
      interaction.guild,
      '✅ Denuvo Blacklist Removed',
      `Staff ${interaction.user} removed ${user} from the Denuvo ticket blacklist.`,
      0x57F287,
    );
  }
}
