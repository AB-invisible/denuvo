import { CONFIG } from '../config';
import { logAction } from '../utils/logging';
import { eaSubmitCode } from '../utils/eaService';

/**
 * /eacode code:<digits> — owner-only: submit the verification code EA emailed
 * during /ealogin (or a mint that hit verification). Finishes the login and
 * saves the trust cookies so EA won't ask again.
 */
export async function execute(interaction: any): Promise<void> {
  if (interaction.guildId !== CONFIG.OWNER_GUILD_ID) {
    return interaction.editReply({ content: '❌ This command is only available in the owner server.' });
  }

  const code = (interaction.options.getString('code', true) || '').replace(/\D/g, '');
  if (code.length < 4) {
    return interaction.editReply({ content: '❌ Enter the numeric code EA emailed you, e.g. `/eacode code:123456`.' });
  }

  const result = await eaSubmitCode(code);

  if (result.ok) {
    await interaction.editReply({
      content: `✅ EA verified & logged in${result.email ? ` (**${result.email}**)` : ''}. Trust cookies saved — it won't ask for a code again.`,
    });
  } else {
    const hint =
      result.code === 'InvalidCode'
        ? ' Double-check the digits, or run `/ealogin` to request a fresh code.'
        : result.code === 'NoPendingVerification'
        ? ' Run `/ealogin` first to trigger the code.'
        : '';
    await interaction.editReply({ content: `❌ ${result.message || result.error || 'Code submission failed'}.${hint}` });
  }

  if (interaction.guild) {
    // Never log the code itself.
    await logAction(
      interaction.guild,
      '🔐 EA Code',
      `Staff submitted an EA verification code — ${result.ok ? 'success' : result.code || 'failed'}.`,
      result.ok ? 0x57f287 : 0xed4245,
    );
  }
}
