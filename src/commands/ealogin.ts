import { CONFIG } from '../config';
import { logAction } from '../utils/logging';
import { eaLoginStart } from '../utils/eaService';

/**
 * /ealogin — owner-only: force a fresh login of the env EA account. If EA wants
 * an email code, this emails it and tells the owner to run /eacode. One-time:
 * trust cookies are saved afterward so EA stops asking.
 */
export async function execute(interaction: any): Promise<void> {
  if (interaction.guildId !== CONFIG.OWNER_GUILD_ID) {
    return interaction.editReply({ content: '❌ This command is only available in the owner server.' });
  }

  const result = await eaLoginStart();

  if (result.ok) {
    await interaction.editReply({
      content: `✅ EA account logged in${result.email ? ` (**${result.email}**)` : ''}. Trust cookies saved — it won't ask again.`,
    });
  } else if (result.status === 'code_pending') {
    await interaction.editReply({
      content:
        `📧 EA emailed a verification code to **${result.email || 'your email'}**.\n\n` +
        `Check the inbox, then run \`/eacode code:123456\` to finish. This is a **one-time** step — after it, EA remembers the machine and stops asking.`,
    });
  } else {
    await interaction.editReply({
      content: `❌ EA login failed${result.code ? ` (\`${result.code}\`)` : ''}: ${result.message || result.error || 'unknown error'}`,
    });
  }

  if (interaction.guild) {
    await logAction(
      interaction.guild,
      '🔐 EA Login',
      `Staff ran \`/ealogin\` — ${result.ok ? 'logged in' : result.status || result.code || 'failed'}.`,
      result.ok ? 0x57f287 : 0xfee75c,
    );
  }
}
