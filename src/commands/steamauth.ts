import { EmbedBuilder } from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { utcDateKey } from '../utils/steampassPool';
import { logAction } from '../utils/logging';
import {
  checkSteamAuthHealth,
  getSteamAuthAccount,
  isSteamAuthConfigured,
} from '../utils/steamAuthClient';
import {
  discoverSteamAuthMatches,
  resolveApiAccountLogin,
  syncSteamAuthLinks,
  upsertSteamAuthLink,
} from '../utils/steamAuthAccounts';

/**
 * /steamauth — owner-only management of GameGen Auth Service accounts.
 * Credentials are fetched at gen time via GET /api/v1/accounts/:id/credentials
 * (API key only — no Steam password stored on the bot).
 *
 *   /steamauth link account_id:<uuid> appid:<id> [label]
 *   /steamauth sync — auto-link all API accounts that match catalog games
 *   /steamauth discover — preview matches before syncing
 *   /steamauth list | status | remove
 */
export async function execute(interaction: any): Promise<void> {
  if (interaction.guildId !== CONFIG.OWNER_GUILD_ID) {
    return interaction.editReply({ content: '❌ This command is only available in the owner server.' });
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    if (!isSteamAuthConfigured()) {
      return interaction.editReply({
        content:
          '⚠️ **SteamAuth not configured.** Set `STEAMAUTH_API_KEY` in the bot env (create a key at https://steamauth.gamegen.lol/dashboard).',
      });
    }
    const health = await checkSteamAuthHealth();
    if (!health.ok) {
      return interaction.editReply({ content: `❌ SteamAuth API unreachable: ${health.error}` });
    }
    return interaction.editReply({
      content:
        `✅ **SteamAuth API OK** — ${health.accountCount} account(s) visible via API.\n` +
        `URL: \`${CONFIG.STEAMAUTH_API_URL}\`\n` +
        `API: \`GET /api/v1/accounts/:id/credentials\` (API key only, no password stored)\n` +
        `Link with \`/steamauth sync\` or \`/steamauth link\` — top autogen priority.`,
    });
  }

  if (sub === 'sync') {
    if (!isSteamAuthConfigured()) {
      return interaction.editReply({ content: '❌ Set `STEAMAUTH_API_KEY` first, then retry.' });
    }
    try {
      const { linked, skipped } = await syncSteamAuthLinks('');
      const { syncAllOwnerGameStock } = await import('../utils/accountCapacity');
      await syncAllOwnerGameStock();
      const { refreshAllPanels } = await import('../utils/panelManager');
      refreshAllPanels();
      await interaction.editReply({
        content:
          `✅ **SteamAuth sync complete** — ${linked} new link(s) created, ${skipped} already linked.\n` +
          (linked === 0 && skipped === 0
            ? 'No API accounts match your catalog. Run `/steamauth discover` or sync games on the dashboard.'
            : 'Linked accounts are tried **first** for autogen.'),
      });
      if (interaction.guild && linked > 0) {
        await logAction(interaction.guild, '🔐 SteamAuth Sync', `Owner synced SteamAuth links: ${linked} new, ${skipped} existing.`, 0x57F287);
      }
    } catch (e) {
      return interaction.editReply({ content: `❌ Sync failed: ${(e as Error).message}` });
    }
    return;
  }

  if (sub === 'discover') {
    if (!isSteamAuthConfigured()) {
      return interaction.editReply({ content: '❌ Set `STEAMAUTH_API_KEY` first, then retry.' });
    }
    try {
      const matches = await discoverSteamAuthMatches();
      if (matches.length === 0) {
        return interaction.editReply({
          content: '📭 No SteamAuth accounts match games in your catalog. Sync games on the dashboard first.',
        });
      }
      let body = '';
      for (const m of matches) {
        const shortId = m.apiAccount.account_id.slice(0, 8) + '…';
        body += `**${m.apiAccount.steam_username}** (\`${shortId}\`)\n`;
        for (let i = 0; i < m.appIds.length; i++) {
          body += `╰─ AppID \`${m.appIds[i]}\` — **${m.gameNames[i]}**\n`;
        }
      }
      const embed = new EmbedBuilder()
        .setTitle('🔍 SteamAuth discover')
        .setDescription(body)
        .setColor(0x5865F2)
        .setFooter({ text: 'Run /steamauth sync to auto-link, or /steamauth link account_id:<uuid> appid:<id>' })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    } catch (e) {
      return interaction.editReply({ content: `❌ Discover failed: ${(e as Error).message}` });
    }
  }

  if (sub === 'link') {
    if (!isSteamAuthConfigured()) {
      return interaction.editReply({ content: '❌ Set `STEAMAUTH_API_KEY` in env before linking accounts.' });
    }

    const accountId = interaction.options.getString('account_id', true).trim();
    const appId = interaction.options.getInteger('appid', true);
    const label = (interaction.options.getString('label') || '').trim() || null;
    const loginOverride = (interaction.options.getString('login') || '').trim();

    if (appId <= 0) return interaction.editReply({ content: '❌ AppID must be a positive number.' });
    if (!accountId) return interaction.editReply({ content: '❌ account_id is required.' });

    try {
      let steamLogin = loginOverride;
      if (!steamLogin) {
        steamLogin = await resolveApiAccountLogin(accountId);
      }
      if (!steamLogin) {
        return interaction.editReply({ content: '❌ Could not resolve steam username from API — pass `login:` manually.' });
      }

      const apiAcct = await getSteamAuthAccount(accountId).catch(() => null);
      if (apiAcct?.guard_revoked) {
        return interaction.editReply({ content: '❌ That SteamAuth account has Guard revoked on the service.' });
      }

      const acct = await upsertSteamAuthLink({
        guildId: '',
        appId,
        accountId,
        steamLogin,
        label,
      });

      const game = await prisma.game.findFirst({ where: { appId } });
      const gameName = game?.name || `AppID ${appId}`;
      const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
      const { syncStockForAppId } = await import('../utils/accountCapacity');
      const remaining = await syncStockForAppId(appId);
      const { refreshAllPanels } = await import('../utils/panelManager');
      refreshAllPanels();
      await interaction.editReply({
        content:
          `✅ **SteamAuth account linked** (#${acct.id}) for **${gameName}** (AppID \`${appId}\`).\n` +
          `• Service ID: \`${accountId}\`\n` +
          `• Steam login: \`${steamLogin}\`\n` +
          `• Auth: 🔐 API key → \`GET /credentials\` (no password stored on bot)\n\n` +
          `Autogen tries this account **first** for **${gameName}** — up to \`${cap}\`/day.\n` +
          `Panel stock for **${gameName}** is now **${Math.max(0, remaining)}** token(s) remaining today.`,
      });
      if (interaction.guild) {
        await logAction(
          interaction.guild,
          '🔐 SteamAuth Account Linked',
          `Owner linked SteamAuth \`${steamLogin}\` (#${acct.id}) for **${gameName}** (AppID \`${appId}\`).`,
          0x57F287,
        );
      }
    } catch (e) {
      return interaction.editReply({ content: `❌ Failed to link account: ${(e as Error).message}` });
    }
    return;
  }

  if (sub === 'remove') {
    const id = interaction.options.getInteger('id', true);
    try {
      const acct = await (prisma as any).steamAuthAccount.findUnique({ where: { id } }).catch(() => null);
      if (!acct) return interaction.editReply({ content: `❌ No SteamAuth link with ID \`${id}\`.` });
      await (prisma as any).steamAuthAccount.delete({ where: { id } });
      const { syncStockForAppId } = await import('../utils/accountCapacity');
      await syncStockForAppId(acct.appId);
      const { refreshAllPanels } = await import('../utils/panelManager');
      refreshAllPanels();
      await interaction.editReply({
        content: `🗑️ Removed SteamAuth link #${id} (\`${acct.steamLogin}\`, AppID \`${acct.appId}\`).`,
      });
      if (interaction.guild) {
        await logAction(
          interaction.guild,
          '🗑️ SteamAuth Link Removed',
          `Owner removed SteamAuth link \`${acct.steamLogin}\` (#${id}, AppID \`${acct.appId}\`).`,
          0xFEE75C,
        );
      }
    } catch (e) {
      return interaction.editReply({ content: `❌ Failed to remove: ${(e as Error).message}` });
    }
    return;
  }

  // ── list ──
  let accounts: any[] = [];
  try {
    accounts = await (prisma as any).steamAuthAccount.findMany({
      orderBy: [{ appId: 'asc' }, { priority: 'asc' }, { id: 'asc' }],
    });
  } catch (e) {
    return interaction.editReply({ content: `❌ Failed to read links: ${(e as Error).message}` });
  }

  if (accounts.length === 0) {
    const configured = isSteamAuthConfigured();
    return interaction.editReply({
      content:
        '📭 No SteamAuth links yet.\n' +
        (configured
          ? 'Run `/steamauth sync` to auto-link, or `/steamauth discover` then `/steamauth link`.'
          : 'Set `STEAMAUTH_API_KEY` in env, then use `/steamauth sync`.'),
    });
  }

  const today = utcDateKey();
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const appIds = [...new Set(accounts.map((a) => a.appId))];
  const games = await prisma.game.findMany({ where: { appId: { in: appIds } } });
  const nameByAppId = new Map(games.map((g) => [g.appId, g.name]));

  let lines = '';
  for (const a of accounts) {
    let used = 0;
    try {
      const u = await (prisma as any).steamAuthUsage.findUnique({
        where: { accountId_usageDate: { accountId: a.id, usageDate: today } },
      });
      used = u?.count ?? 0;
    } catch {
      used = 0;
    }
    const gname = nameByAppId.get(a.appId) || `AppID ${a.appId}`;
    const tokenState = (a.refreshToken || '').trim() ? '✅ token cached' : '⏳ cold start';
    const fails = a.failureCount ? ` • ⚠️${a.failureCount} fail(s)` : '';
    const shortSvc = String(a.accountId).slice(0, 8) + '…';
    lines += `**#${a.id}** \`${a.steamLogin}\` → **${gname}**\n╰─ svc \`${shortSvc}\` · ${used}/${cap} today · ${tokenState} · 🔐 API credentials${fails}\n`;
  }

  const apiState = isSteamAuthConfigured() ? '✅ API key set' : '⚠️ STEAMAUTH_API_KEY missing';
  const embed = new EmbedBuilder()
    .setTitle('🔐 SteamAuth Links (GameGen Auth Service)')
    .setDescription(lines)
    .setColor(0x5865F2)
    .setFooter({ text: `${apiState} · Top autogen priority · GET /credentials at gen time` })
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}
