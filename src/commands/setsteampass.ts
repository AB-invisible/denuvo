import prisma from '../lib/prisma';
import { logAction } from '../utils/logging';

export async function execute(interaction: any): Promise<void> {
  const newToken = (interaction.options.getString('token') || '').trim();
  const shouldClear = interaction.options.getBoolean('clear') === true;

  if (shouldClear) {
    await prisma.metadata.deleteMany({ where: { key: 'steampass_token' } });
    await interaction.editReply({
      content:
        '🗑️ **Cached token cleared.** The bot will fall back to `/auth/login` on the next token request — ' +
        'expect an email-code prompt or a rate-limit response if steampass is being strict. ' +
        'Run `/setsteampass token:<value>` to provide a fresh one.',
    });
    if (interaction.guild) {
      await logAction(interaction.guild, '🔑 Steampass Token Cleared', `Staff ${interaction.user} cleared the cached steampass bearer token.`, 0xFEE75C);
    }
    return;
  }

  if (!newToken) {
    const existing = await prisma.metadata.findUnique({ where: { key: 'steampass_token' } });
    const status = existing?.value
      ? `✅ A cached token is set (${existing.value.slice(0, 8)}…${existing.value.slice(-4)}, length ${existing.value.length}).`
      : '⚠️ No cached token. The bot is falling back to `/auth/login` — expect email-code prompts.';
    await interaction.editReply({
      content:
        `🔑 **Steampass token status:** ${status}\n\n` +
        `**To refresh:**\n` +
        `1. Log in to https://steampass.gg in your browser (complete the email-code step).\n` +
        `2. Open DevTools → Network tab → click any API request → copy the value of the \`Authorization\` header (everything after \`Bearer \`).\n` +
        `3. Run \`/setsteampass token:<that value>\`.\n\n` +
        `Or run \`/setsteampass clear:True\` to remove the cached token.`,
    });
    return;
  }

  const cleanedToken = newToken.replace(/^Bearer\s+/i, '').trim();
  await prisma.metadata.upsert({
    where: { key: 'steampass_token' },
    update: { value: cleanedToken },
    create: { key: 'steampass_token', value: cleanedToken },
  });

  await interaction.editReply({
    content:
      `✅ **Cached steampass bearer token saved** (${cleanedToken.slice(0, 8)}…${cleanedToken.slice(-4)}, length ${cleanedToken.length}). ` +
      `The bot will now skip \`/auth/login\` for every token request and use this bearer directly. ` +
      `If steampass invalidates the session, the bot will fail with a 401 — refresh via \`/setsteampass\` then.`,
  });
  if (interaction.guild) {
    await logAction(interaction.guild, '🔑 Steampass Token Updated', `Staff ${interaction.user} refreshed the cached steampass bearer token (length ${cleanedToken.length}).`, 0x57F287);
  }
}
