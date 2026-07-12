import { CONFIG } from '../config';
import { logAction } from '../utils/logging';
import { eaImportSession } from '../utils/eaService';

/**
 * /easession import remid:<cookie> — owner-only: import remid from a browser
 * login at signin.ea.com. Bypasses Railway captcha entirely (the reliable fix).
 */
export async function execute(interaction: any): Promise<void> {
  if (interaction.guildId !== CONFIG.OWNER_GUILD_ID) {
    return interaction.editReply({ content: '❌ This command is only available in the owner server.' });
  }

  const action = interaction.options.getString('action', true);
  if (action === 'help' || action !== 'import') {
    return interaction.editReply({
      content:
        '**How to import a session (bypasses captcha):**\n' +
        '1. Open https://signin.ea.com in Chrome and log in normally\n' +
        '2. F12 → Application → Cookies → `https://signin.ea.com` → copy the **remid** value\n' +
        '3. Run `/easession action:import remid:<paste here>`',
    });
  }

  const remid = (interaction.options.getString('remid', true) || '').trim();
  if (remid.length < 8) {
    return interaction.editReply({
      content: '❌ Paste the full **remid** cookie from your browser (F12 → Application → Cookies → signin.ea.com).',
    });
  }

  const result = await eaImportSession(remid);

  if (result.ok) {
    await interaction.editReply({
      content:
        `✅ EA session imported${result.email ? ` for **${result.email}**` : ''}. ` +
        `The service can mint tokens now — no captcha, no email code.`,
    });
  } else {
    const hint =
      result.code === 'AuthError'
        ? '\n\nThe remid may be expired — log in again at https://signin.ea.com and copy a fresh remid.'
        : '';
    await interaction.editReply({
      content: `❌ Session import failed${result.code ? ` (\`${result.code}\`)` : ''}: ${result.message || result.error || 'unknown error'}${hint}`,
    });
  }

  if (interaction.guild) {
    await logAction(
      interaction.guild,
      '🔐 EA Session',
      `Staff ran \`/easession import\` — ${result.ok ? 'success' : result.code || 'failed'}.`,
      result.ok ? 0x57f287 : 0xed4245,
    );
  }
}
