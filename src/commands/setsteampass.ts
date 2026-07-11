import prisma from '../lib/prisma';
import { logAction } from '../utils/logging';
import { resetSteampassBreaker } from '../utils/steampassCircuit';

export async function execute(interaction: any): Promise<void> {
  const newToken = (interaction.options.getString('token') || '').trim();
  const shouldClear = interaction.options.getBoolean('clear') === true;
  const accountId = interaction.options.getInteger('account');

  // ── Owner-pool account branch ──
  // Targets a specific SteampassAccount row so that pool account can skip
  // /auth/login just like the global account does.
  if (accountId != null) {
    const acct = await (prisma as any).steampassAccount.findUnique({ where: { id: accountId } }).catch(() => null);
    if (!acct) {
      await interaction.editReply({ content: `⚠️ No owner-pool account found with ID \`${accountId}\`. Run \`/steampass\` to list account IDs.` });
      return;
    }

    if (shouldClear) {
      await (prisma as any).steampassAccount.update({ where: { id: accountId }, data: { token: '' } });
      await interaction.editReply({
        content:
          `🗑️ **Token cleared for pool account #${accountId}** (\`${acct.login}\`). ` +
          `It will fall back to \`/auth/login\` on its next gen — expect email-code/rate-limit issues if steampass is strict.`,
      });
      if (interaction.guild) {
        await logAction(interaction.guild, '🔑 Pool Steampass Token Cleared', `Staff ${interaction.user} cleared the cached token for pool account #${accountId} (${acct.login}).`, 0xFEE75C);
      }
      return;
    }

    if (!newToken) {
      const status = (acct.token || '').trim()
        ? `✅ A cached token is set (${acct.token.slice(0, 8)}…${acct.token.slice(-4)}, length ${acct.token.length}).`
        : '⚠️ No cached token — this account falls back to `/auth/login` (email-code/rate-limit risk).';
      await interaction.editReply({
        content:
          `🔑 **Pool account #${accountId}** (\`${acct.login}\`) token status: ${status}\n\n` +
          `**To set:** log in to https://steampass.gg **as this account**, copy the \`Authorization\` bearer from DevTools → Network, then run \`/setsteampass account:${accountId} token:<value>\`.`,
      });
      return;
    }

    const cleaned = newToken.replace(/^Bearer\s+/i, '').trim();
    await (prisma as any).steampassAccount.update({ where: { id: accountId }, data: { token: cleaned } });
    // A fresh bearer means steampass is reachable again — close the breaker.
    await resetSteampassBreaker();
    await interaction.editReply({
      content:
        `✅ **Cached bearer saved for pool account #${accountId}** (\`${acct.login}\`, token ${cleaned.slice(0, 8)}…${cleaned.slice(-4)}, length ${cleaned.length}). ` +
        `This account will now skip \`/auth/login\`. Refresh via \`/setsteampass account:${accountId}\` if steampass invalidates it (401).`,
    });
    if (interaction.guild) {
      await logAction(interaction.guild, '🔑 Pool Steampass Token Updated', `Staff ${interaction.user} set the cached token for pool account #${accountId} (${acct.login}, length ${cleaned.length}).`, 0x57F287);
    }
    return;
  }

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
  // A fresh bearer means steampass is reachable again — close the breaker.
  await resetSteampassBreaker();

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
