import { EmbedBuilder } from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { getPoolStatus } from '../utils/steampassPool';

/**
 * /steamhealth — owner-only visibility into the Steam session cache.
 *
 * Shows, per (steampass account, game), whether a live refresh_token is
 * cached. A row with a token means the NEXT gen of that game on that
 * account skips steampass entirely; a "creds-only" row means it still has
 * to fetch a Steam Guard code from steampass (1 call). Also shows each pool
 * account's cached steampass bearer (skips /auth/login) and today's usage.
 */
export async function execute(interaction: any): Promise<void> {
  if (interaction.guildId !== CONFIG.OWNER_GUILD_ID) {
    return interaction.editReply({ content: '❌ This command is only available in the owner server.' });
  }

  let sessions: any[] = [];
  try {
    sessions = await (prisma as any).steamSession.findMany({
      orderBy: [{ steampassLogin: 'asc' }, { updatedAt: 'desc' }],
    });
  } catch (e) {
    return interaction.editReply({ content: `❌ Failed to read SteamSession table: ${(e as Error).message}` });
  }

  // Map product UUID -> game name for readable rows.
  const games = await prisma.game.findMany({
    where: { steampassUuid: { not: null } },
    select: { name: true, steampassUuid: true },
  });
  const uuidToGame = new Map<string, string>();
  for (const g of games) if (g.steampassUuid) uuidToGame.set(g.steampassUuid, g.name);

  const withToken = sessions.filter((s) => (s.refreshToken || '').trim()).length;
  const total = sessions.length;

  const embed = new EmbedBuilder()
    .setTitle('🩺 Steam Session Health')
    .setColor(0x5865F2)
    .setTimestamp()
    .setDescription(
      `**Cached Steam sessions:** ${total}\n` +
      `**With live refresh_token** (gen skips steampass): **${withToken}**\n` +
      `**Creds-only** (still fetches a guard code from steampass): **${total - withToken}**`
    );

  // Pool accounts + their cached steampass bearer.
  try {
    const pool = await getPoolStatus();
    if (pool.length) {
      const lines = pool
        .map((a) =>
          `${a.active ? '🟢' : '⚫'} \`${a.login}\`${a.label ? ` (${a.label})` : ''} — bearer ${a.hasToken ? '✅' : '❌'} • used today: ${a.usedToday}`
        )
        .join('\n');
      embed.addFields({ name: '🔑 Pool accounts (steampass bearer = skips /auth/login)', value: lines.slice(0, 1024) });
    }
  } catch { /* pool status is best-effort */ }

  if (total === 0) {
    embed.addFields({ name: '📦 Cached sessions', value: '*None yet — every gen currently bootstraps through steampass.*' });
  } else {
    const shown = sessions.slice(0, 20).map((s) => {
      const game = uuidToGame.get(s.steampassUuid) || `UUID ${String(s.steampassUuid).slice(0, 8)}…`;
      const hasToken = (s.refreshToken || '').trim().length > 0;
      const hasCreds = (s.steamLogin || '').trim().length > 0;
      // Lead with what the NEXT gen will actually do (driven by what's
      // cached), not how the last one happened to log in — a row with a
      // refresh_token skips steampass regardless of its last source.
      const next = hasToken
        ? '⚡ refresh_token (skips steampass)'
        : hasCreds
          ? '🔑 cached creds (1 guard-code call)'
          : '🐢 steampass (cold start)';
      // Last source is shown as secondary context only.
      const last = s.lastLoginSource ? ` · last: ${s.lastLoginSource}` : '';
      const fails = s.failureCount ? ` · ⚠️${s.failureCount} fail(s)` : '';
      const acct = s.steampassLogin || 'home-env';
      return `**${game}** · \`${acct}\` — ${next}${last}${fails}`;
    }).join('\n');
    embed.addFields({
      name: `📦 Cached sessions${total > 20 ? ` (first 20 of ${total})` : ''}`,
      value: shown.slice(0, 1024),
    });
  }

  embed.setFooter({ text: '⚡ = next gen reuses a cached refresh_token (no steampass) · 🔑 = 1 guard-code call · last: = how the previous gen logged in' });

  await interaction.editReply({ embeds: [embed] });
}
