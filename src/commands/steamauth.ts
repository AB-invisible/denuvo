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
  upsertSteamAuthLink,
} from '../utils/steamAuthAccounts';

/**
 * /steamauth — owner-only management of GameGen Auth Service accounts.
 * Guard codes are fetched from steamauth.gamegen.lol at gen time; the bot
 * stores the Steam password locally only to verify with the API.
 *
 *   /steamauth link account_id:<uuid> appid:<id> password:<pw> [label]
 *   /steamauth discover — show API accounts matched to catalog games
 *   /steamauth list
 *   /steamauth status — API connectivity check
 *   /steamauth remove id:<row id>
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
        `Link accounts with \`/steamauth link\` — they are tried first for autogen.`,
    });
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
        .setFooter({ text: 'Link with /steamauth link account_id:<uuid> appid:<id> password:<steam pw>' })
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
    const password = interaction.options.getString('password', true);
    const label = (interaction.options.getString('label') || '').trim() || null;
    const loginOverride = (interaction.options.getString('login') || '').trim();

    if (appId <= 0) return interaction.editReply({ content: '❌ AppID must be a positive number.' });
    if (!accountId || !password) return interaction.editReply({ content: '❌ account_id and password are required.' });

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
        steamPassword: password,
        label,
      });

      const game = await prisma.game.findFirst({ where: { appId } });
      const gameName = game?.name || `AppID ${appId}`;
      const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
      await interaction.editReply({
        content:
          `✅ **SteamAuth account linked** (#${acct.id}) for **${gameName}** (AppID \`${appId}\`).\n` +
          `• Service ID: \`${accountId}\`\n` +
          `• Steam login: \`${steamLogin}\`\n` +
          `• Guard: 🔐 via GameGen Auth Service (no local shared_secret)\n\n` +
          `Autogen tries this account **first** for **${gameName}** — up to \`${cap}\`/day, then BYO accounts, then steampass.`,
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
          ? 'Run `/steamauth discover` then `/steamauth link` to connect accounts.'
          : 'Set `STEAMAUTH_API_KEY` in env, then use `/steamauth link`.'),
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
    const tokenState = (a.refreshToken || '').trim() ? '✅ token cached' : '⏳ no token yet';
    const fails = a.failureCount ? ` • ⚠️${a.failureCount} fail(s)` : '';
    const shortSvc = String(a.accountId).slice(0, 8) + '…';
    lines += `**#${a.id}** \`${a.steamLogin}\` → **${gname}**\n╰─ svc \`${shortSvc}\` · ${used}/${cap} today · ${tokenState} · 🔐 API guard${fails}\n`;
  }

  const apiState = isSteamAuthConfigured() ? '✅ API key set' : '⚠️ STEAMAUTH_API_KEY missing';
  const embed = new EmbedBuilder()
    .setTitle('🔐 SteamAuth Links (GameGen Auth Service)')
    .setDescription(lines)
    .setColor(0x5865F2)
    .setFooter({ text: `${apiState} · Top autogen priority, then BYO accounts, then steampass` })
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}
