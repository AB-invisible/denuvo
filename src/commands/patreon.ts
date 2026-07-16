import { EmbedBuilder } from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { logAction } from '../utils/logging';
import { isPatreonConfigured } from '../utils/patreonClient';
import { runFullPatreonSync, getLastSyncSummary, type PatreonTier } from '../utils/patreonRoles';

const TIER_EMOJI: Record<PatreonTier, string> = { gold: '🥇', silver: '🥈', bronze: '🥉' };

function fmtAgo(date: Date): string {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/**
 * /patreon — owner-only management of the Patreon → Discord role sync.
 *
 *   /patreon status — config check + last sync summary
 *   /patreon sync   — trigger a full campaign reconciliation now
 *   /patreon list   — show tiered patrons + patrons needing a Discord link
 */
export async function execute(interaction: any): Promise<void> {
  if (interaction.guildId !== CONFIG.OWNER_GUILD_ID) {
    return interaction.editReply({ content: '❌ This command is only available in the owner server.' });
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    if (!isPatreonConfigured()) {
      return interaction.editReply({
        content:
          '⚠️ **Patreon sync not configured.** Set `PATREON_ACCESS_TOKEN` and `PATREON_CAMPAIGN_ID` in the bot env.\n' +
          'See `.env.example` for the full setup steps (client, campaign id, tier ids, webhook).',
      });
    }

    const tierLines: string[] = [];
    for (const t of ['gold', 'silver', 'bronze'] as PatreonTier[]) {
      const patreonTierId = t === 'gold' ? CONFIG.PATREON_TIER_GOLD_ID : t === 'silver' ? CONFIG.PATREON_TIER_SILVER_ID : CONFIG.PATREON_TIER_BRONZE_ID;
      const roleId = t === 'gold' ? CONFIG.GOLD_ROLE_ID : t === 'silver' ? CONFIG.SILVER_ROLE_ID : CONFIG.BRONZE_ROLE_ID;
      tierLines.push(
        `${TIER_EMOJI[t]} **${t}** — Patreon tier \`${patreonTierId || 'not set'}\` → <@&${roleId || '0'}>`,
      );
    }

    const summary = await getLastSyncSummary();
    const syncLine = summary
      ? `Last sync: **${new Date(summary.finishedAt).toLocaleString()}** (${fmtAgo(new Date(summary.finishedAt))}) — ` +
        `${summary.total} member(s), ${summary.activePatrons} active, ${summary.roled} role change(s), ` +
        `${summary.unlinked} unlinked, ${summary.errors} error(s).`
      : 'No sync has run yet — it kicks off automatically ~10s after bot startup.';

    const webhookState = CONFIG.PATREON_WEBHOOK_SECRET ? '✅ configured' : '⚠️ `PATREON_WEBHOOK_SECRET` not set — real-time updates disabled, relying on periodic sync only';

    return interaction.editReply({
      content:
        `✅ **Patreon sync configured** — campaign \`${CONFIG.PATREON_CAMPAIGN_ID}\`, reconciling every **${CONFIG.PATREON_SYNC_INTERVAL_MINUTES}m**.\n\n` +
        `${tierLines.join('\n')}\n` +
        `Donator role: <@&${CONFIG.DONATOR_ROLE_ID || '0'}> (any active patron, any tier)\n\n` +
        `Webhook: ${webhookState}\n` +
        `Endpoint: \`POST /webhooks/patreon\` (triggers: members:pledge:create/update/delete)\n\n` +
        `${syncLine}`,
    });
  }

  if (sub === 'sync') {
    if (!isPatreonConfigured()) {
      return interaction.editReply({ content: '❌ Set `PATREON_ACCESS_TOKEN` and `PATREON_CAMPAIGN_ID` first, then retry.' });
    }
    try {
      const summary = await runFullPatreonSync(interaction.client);
      await interaction.editReply({
        content:
          `✅ **Patreon sync complete** — ${summary.total} member(s) checked, ${summary.activePatrons} active patron(s), ` +
          `${summary.roled} role change(s) applied, ${summary.unlinked} unlinked (no Discord on their Patreon), ` +
          `${summary.errors} error(s).`,
      });
      if (interaction.guild) {
        await logAction(interaction.guild, '💠 Patreon Sync', `Owner ran a manual Patreon sync — ${summary.roled} role change(s), ${summary.unlinked} unlinked.`, 0x5865F2);
      }
    } catch (e) {
      return interaction.editReply({ content: `❌ Sync failed: ${(e as Error).message}` });
    }
    return;
  }

  // ── list ──
  if (!isPatreonConfigured()) {
    return interaction.editReply({ content: '❌ Set `PATREON_ACCESS_TOKEN` and `PATREON_CAMPAIGN_ID` first, then run `/patreon sync`.' });
  }

  let rows: any[] = [];
  try {
    rows = await (prisma as any).patreonMember.findMany({ orderBy: [{ updatedAt: 'desc' }], take: 500 });
  } catch (e) {
    return interaction.editReply({ content: `❌ Failed to read Patreon members: ${(e as Error).message}` });
  }

  if (rows.length === 0) {
    return interaction.editReply({ content: '📭 No Patreon members synced yet — run `/patreon sync`.' });
  }

  const tierOrder: Record<string, number> = { gold: 0, silver: 1, bronze: 2 };
  const tiered = rows
    .filter((r) => r.tier && r.discordId)
    .sort((a, b) => (tierOrder[a.tier] ?? 9) - (tierOrder[b.tier] ?? 9))
    .slice(0, 20);
  const unlinkedActive = rows.filter((r) => r.patronStatus === 'active_patron' && !r.discordId).slice(0, 15);

  let body = '';
  if (tiered.length > 0) {
    body += '**Tiered patrons (Discord linked):**\n';
    for (const r of tiered) {
      const emoji = TIER_EMOJI[r.tier as PatreonTier] || '💠';
      body += `${emoji} **${r.tier}** — <@${r.discordId}>\n`;
    }
  } else {
    body += '*No tiered + linked patrons yet.*\n';
  }

  if (unlinkedActive.length > 0) {
    body += `\n⚠️ **Active patrons who haven't linked Discord** (${unlinkedActive.length}) — ask them to connect Discord on patreon.com so roles can sync:\n`;
    for (const r of unlinkedActive) {
      body += `╰─ Patreon member \`${r.patreonMemberId.slice(0, 8)}…\`${r.tier ? ` (${r.tier})` : ''}\n`;
    }
  }

  const embed = new EmbedBuilder()
    .setTitle('💠 Patreon Members')
    .setDescription(body.slice(0, 4000))
    .setColor(0xF96854)
    .setFooter({ text: `${rows.length} total synced · Run /patreon sync to refresh` })
    .setTimestamp();
  return interaction.editReply({ embeds: [embed] });
}
