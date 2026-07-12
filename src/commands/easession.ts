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
        '1. Open **https://www.ea.com/login** in Chrome (works when signin.ea.com hangs)\n' +
        '2. Log in → F12 → **Application** → **Cookies** → check `www.ea.com`, `accounts.ea.com`, or `signin.ea.com`\n' +
        '3. Copy the **remid** value → `/easession action:import remid:<paste>`\n\n' +
        '**Or run locally:** `python ea-service/import_browser_session.py` (opens browser, grabs remid, uploads automatically)',
    });
  }

  const remid = (interaction.options.getString('remid', true) || '').trim();
  if (remid.length < 8) {
    return interaction.editReply({
      content: '❌ Paste the full **remid** cookie (F12 → Application → Cookies → `www.ea.com` or `accounts.ea.com`).',
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
        ? '\n\nThe remid may be expired — log in at https://www.ea.com/login and copy a fresh remid.'
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
