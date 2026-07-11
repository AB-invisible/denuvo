import { EmbedBuilder } from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { utcDateKey } from '../utils/steampassPool';
import { logAction } from '../utils/logging';

/**
 * /steamaccount — owner-only management of owner-provided (BYO) Steam
 * accounts. A registered account is used DIRECTLY (no steampass) for its
 * game, up to the daily Denuvo cap; when spent, gen falls back to steampass.
 *
 *   /steamaccount add appid:<id> login:<user> password:<pw> [shared_secret] [label]
 *   /steamaccount list
 *   /steamaccount remove id:<row id>
 */
export async function execute(interaction: any): Promise<void> {
  if (interaction.guildId !== CONFIG.OWNER_GUILD_ID) {
    return interaction.editReply({ content: '❌ This command is only available in the owner server.' });
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const appId = interaction.options.getInteger('appid', true);
    const login = interaction.options.getString('login', true).trim();
    const password = interaction.options.getString('password', true);
    const sharedSecret = (interaction.options.getString('shared_secret') || '').trim();
    const label = (interaction.options.getString('label') || '').trim() || null;

    if (appId <= 0) return interaction.editReply({ content: '❌ AppID must be a positive number.' });
    if (!login || !password) return interaction.editReply({ content: '❌ Login and password are required.' });

    try {
      const acct = await (prisma as any).ownedSteamAccount.upsert({
        where: { guildId_appId_steamLogin: { guildId: '', appId, steamLogin: login } },
        update: { steamPassword: password, sharedSecret: sharedSecret || null, label, active: true },
        create: { guildId: '', appId, steamLogin: login, steamPassword: password, sharedSecret: sharedSecret || null, label },
      });

      const game = await prisma.game.findFirst({ where: { appId } });
      const gameName = game?.name || `AppID ${appId}`;
      const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
      const { syncStockForAppId } = await import('../utils/accountCapacity');
      const remaining = await syncStockForAppId(appId, CONFIG.OWNER_GUILD_ID, { forceRaise: true });
      const { refreshAllPanels } = await import('../utils/panelManager');
      refreshAllPanels();
      await interaction.editReply({
        content:
          `✅ **Steam account saved** (#${acct.id}) for **${gameName}** (AppID \`${appId}\`).\n` +
          `• Login: \`${login}\`\n` +
          `• Steam Guard: ${sharedSecret ? '🔐 TOTP (shared_secret set)' : '🔓 none (login + password only)'}\n\n` +
          `The bot uses this account **after SteamAuth** for **${gameName}** — up to \`${cap}\` tokens/day — then falls back to steampass. ` +
          `First gen does a full login to cache a refresh_token; after that it's login-free until the token expires (~200 days).\n` +
          `Panel stock for **${gameName}** is now **${Math.max(0, remaining)}** token(s) remaining today.`,
      });
      if (interaction.guild) {
        await logAction(interaction.guild, '🎮 Owned Steam Account Added', `Owner added Steam account \`${login}\` (#${acct.id}) for **${gameName}** (AppID \`${appId}\`). Guard: ${sharedSecret ? 'TOTP' : 'none'}.`, 0x57F287);
      }
    } catch (e) {
      return interaction.editReply({ content: `❌ Failed to save account: ${(e as Error).message}` });
    }
    return;
  }

  if (sub === 'remove') {
    const id = interaction.options.getInteger('id', true);
    try {
      const acct = await (prisma as any).ownedSteamAccount.findUnique({ where: { id } }).catch(() => null);
      if (!acct) return interaction.editReply({ content: `❌ No owned Steam account with ID \`${id}\`.` });
      await (prisma as any).ownedSteamAccount.delete({ where: { id } });
      const { syncStockForAppId } = await import('../utils/accountCapacity');
      await syncStockForAppId(acct.appId);
      const { refreshAllPanels } = await import('../utils/panelManager');
      refreshAllPanels();
      await interaction.editReply({ content: `🗑️ Removed Steam account #${id} (\`${acct.steamLogin}\`, AppID \`${acct.appId}\`). Stock resynced.` });
      if (interaction.guild) {
        await logAction(interaction.guild, '🗑️ Owned Steam Account Removed', `Owner removed Steam account \`${acct.steamLogin}\` (#${id}, AppID \`${acct.appId}\`).`, 0xFEE75C);
      }
    } catch (e) {
      return interaction.editReply({ content: `❌ Failed to remove: ${(e as Error).message}` });
    }
    return;
  }

  // ── list ──
  let accounts: any[] = [];
  try {
    accounts = await (prisma as any).ownedSteamAccount.findMany({ orderBy: [{ appId: 'asc' }, { priority: 'asc' }, { id: 'asc' }] });
  } catch (e) {
    return interaction.editReply({ content: `❌ Failed to read accounts: ${(e as Error).message}` });
  }
  if (accounts.length === 0) {
    return interaction.editReply({ content: '📭 No owned Steam accounts registered yet. Add one with `/steamaccount add`.' });
  }

  const today = utcDateKey();
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const appIds = [...new Set(accounts.map(a => a.appId))];
  const games = await prisma.game.findMany({ where: { appId: { in: appIds } } });
  const nameByAppId = new Map(games.map(g => [g.appId, g.name]));

  let lines = '';
  for (const a of accounts) {
    let used = 0;
    try {
      const u = await (prisma as any).ownedSteamUsage.findUnique({ where: { accountId_usageDate: { accountId: a.id, usageDate: today } } });
      used = u?.count ?? 0;
    } catch { used = 0; }
    const gname = nameByAppId.get(a.appId) || `AppID ${a.appId}`;
    const tokenState = (a.refreshToken || '').trim() ? '✅ token cached' : '⏳ no token yet';
    const guard = (a.sharedSecret || '').trim() ? '🔐 TOTP' : '🔓 no guard';
    const fails = a.failureCount ? ` • ⚠️${a.failureCount} fail(s)` : '';
    lines += `**#${a.id}** \`${a.steamLogin}\` → **${gname}**\n╰─ ${used}/${cap} today · ${tokenState} · ${guard}${fails}\n`;
  }

  const embed = new EmbedBuilder()
    .setTitle('🎮 Owned Steam Accounts')
    .setDescription(lines)
    .setColor(0x5865F2)
    .setFooter({ text: 'Used after SteamAuth (5/day), then steampass · ✅ token = repeat gens skip login' })
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}
