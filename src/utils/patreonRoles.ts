/**
 * patreonRoles.ts — applies bronze/silver/gold (+ donator) Discord roles in
 * the owner/home guild based on live Patreon campaign membership.
 *
 * Source of truth on every sync: a fresh Patreon API read + the target
 * member's live Discord roles. The PatreonMember DB row is a cache/audit
 * trail only (see prisma/schema.prisma) — it is never consulted to decide
 * what to add/remove, so a stale or missing row can never cause a wrong
 * grant. Worst case of any failure here is "corrects itself next sync."
 *
 * Two entry points feed the same core (`applySyncForMember`):
 *   - runFullPatreonSync()   — periodic reconciliation of the whole campaign
 *   - syncPatreonMemberById() — one member, triggered by a webhook event
 */

import { Client, Guild, GuildMember } from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import {
  fetchCampaignMember,
  fetchCampaignMembers,
  isPatreonConfigured,
  type PatreonApiMember,
} from './patreonClient';

export type PatreonTier = 'bronze' | 'silver' | 'gold';

const TIER_ROLE_ENV: Record<PatreonTier, string> = {
  gold: CONFIG.GOLD_ROLE_ID,
  silver: CONFIG.SILVER_ROLE_ID,
  bronze: CONFIG.BRONZE_ROLE_ID,
};

const TIER_PATREON_ID: Record<PatreonTier, string> = {
  gold: (CONFIG.PATREON_TIER_GOLD_ID || '').trim(),
  silver: (CONFIG.PATREON_TIER_SILVER_ID || '').trim(),
  bronze: (CONFIG.PATREON_TIER_BRONZE_ID || '').trim(),
};

/** Highest tier wins if a member is somehow entitled to more than one mapped tier. */
const TIER_PRIORITY: PatreonTier[] = ['gold', 'silver', 'bronze'];

export interface PatreonSyncResult {
  memberId: string;
  discordId: string | null;
  tier: PatreonTier | null;
  isActivePatron: boolean;
  applied: boolean;
  reason?: string;
  rolesAdded: string[];
  rolesRemoved: string[];
}

/** Maps a member's Patreon tier IDs -> our bronze/silver/gold label, or null if none match a configured mapping. */
export function resolveTier(tierIds: string[]): PatreonTier | null {
  for (const tier of TIER_PRIORITY) {
    const patreonTierId = TIER_PATREON_ID[tier];
    if (patreonTierId && tierIds.includes(patreonTierId)) return tier;
  }
  return null;
}

function allTierRoleIds(): string[] {
  return TIER_PRIORITY.map((t) => TIER_ROLE_ENV[t]).filter(Boolean);
}

async function upsertPatreonMemberRow(m: PatreonApiMember, tier: PatreonTier | null): Promise<void> {
  try {
    let existing = null;
    if (m.patreonUserId) {
      existing = await (prisma as any).patreonMember.findFirst({
        where: { patreonUserId: m.patreonUserId },
      });
      if (existing && existing.patreonMemberId.startsWith('user:') && existing.patreonMemberId !== m.id) {
        console.log(`[Patreon] Replacing placeholder member row ${existing.patreonMemberId} with real ID ${m.id}`);
        await (prisma as any).patreonMember.delete({
          where: { id: existing.id },
        }).catch(() => {});
      }
    }

    if (!existing) {
      existing = await (prisma as any).patreonMember.findUnique({
        where: { patreonMemberId: m.id },
      });
    }

    const discordId = m.discordId || existing?.discordId || null;

    await (prisma as any).patreonMember.upsert({
      where: { patreonMemberId: m.id },
      update: {
        discordId,
        patreonUserId: m.patreonUserId || existing?.patreonUserId || null,
        patronStatus: m.patronStatus,
        tier,
        tierAmountCents: m.currentlyEntitledAmountCents,
        lastSyncedAt: new Date(),
      },
      create: {
        patreonMemberId: m.id,
        patreonUserId: m.patreonUserId || null,
        discordId,
        patronStatus: m.patronStatus,
        tier,
        tierAmountCents: m.currentlyEntitledAmountCents,
      },
    });
  } catch (e) {
    console.warn('[Patreon] Failed to persist PatreonMember row (non-fatal):', (e as Error).message);
  }
}

/**
 * Applies the correct roles for one Patreon member's current state against
 * the live owner-guild member. Safe to call repeatedly — every call re-reads
 * the member's actual roles before deciding what (if anything) to change.
 */
export async function applySyncForMember(client: Client, apiMember: PatreonApiMember): Promise<PatreonSyncResult> {
  const isActivePatron = apiMember.patronStatus === 'active_patron';
  const tier = isActivePatron ? resolveTier(apiMember.tierIds) : null;

  let existing = null;
  if (apiMember.patreonUserId) {
    existing = await (prisma as any).patreonMember.findFirst({
      where: { patreonUserId: apiMember.patreonUserId },
    });
  }
  if (!existing) {
    existing = await (prisma as any).patreonMember.findUnique({
      where: { patreonMemberId: apiMember.id },
    });
  }
  if (!apiMember.discordId && existing?.discordId) {
    apiMember.discordId = existing.discordId;
  }

  await upsertPatreonMemberRow(apiMember, tier);

  const result: PatreonSyncResult = {
    memberId: apiMember.id,
    discordId: apiMember.discordId,
    tier,
    isActivePatron,
    applied: false,
    rolesAdded: [],
    rolesRemoved: [],
  };

  if (!apiMember.discordId) {
    result.reason = 'Patron has not linked Discord on patreon.com (social_connections.discord empty)';
    return result;
  }

  const guild = client.guilds.cache.get(CONFIG.OWNER_GUILD_ID);
  if (!guild) {
    result.reason = `Owner guild ${CONFIG.OWNER_GUILD_ID} not in bot's cache`;
    return result;
  }

  let member: GuildMember | null = null;
  try {
    member = guild.members.cache.get(apiMember.discordId) || await guild.members.fetch(apiMember.discordId);
  } catch {
    member = null;
  }
  if (!member) {
    result.reason = 'Linked Discord account is not a member of the home server';
    return result;
  }

  try {
    const { added, removed } = await syncMemberRoles(guild, member, isActivePatron, tier);
    result.rolesAdded = added;
    result.rolesRemoved = removed;
    result.applied = true;
  } catch (e) {
    result.reason = (e as Error).message;
  }

  return result;
}

/** Adds/removes the donator role + the single correct tier role on a live GuildMember. */
async function syncMemberRoles(
  guild: Guild,
  member: GuildMember,
  isActivePatron: boolean,
  tier: PatreonTier | null,
): Promise<{ added: string[]; removed: string[] }> {
  const added: string[] = [];
  const removed: string[] = [];
  const has = member.roles.cache;

  // ── Blanket "donator" role: any active pledge, regardless of tier ──
  const donatorRoleId = (CONFIG.DONATOR_ROLE_ID || '').trim();
  if (donatorRoleId && guild.roles.cache.has(donatorRoleId)) {
    const shouldHave = isActivePatron;
    const currentlyHas = has.has(donatorRoleId);
    if (shouldHave && !currentlyHas) {
      await member.roles.add(donatorRoleId, 'Patreon sync: active patron').catch((e) => {
        console.warn(`[Patreon] Failed to add donator role to ${member.id}:`, e?.message || e);
      });
      added.push(donatorRoleId);
    } else if (!shouldHave && currentlyHas) {
      await member.roles.remove(donatorRoleId, 'Patreon sync: pledge no longer active').catch((e) => {
        console.warn(`[Patreon] Failed to remove donator role from ${member.id}:`, e?.message || e);
      });
      removed.push(donatorRoleId);
    }
  }

  // ── Exactly one of bronze/silver/gold, matching the mapped tier ──
  const desiredRoleId = tier ? (TIER_ROLE_ENV[tier] || '').trim() : '';
  for (const roleId of allTierRoleIds()) {
    if (!guild.roles.cache.has(roleId)) continue; // misconfigured/stale role id — skip rather than throw
    const currentlyHas = has.has(roleId);
    const shouldHave = roleId === desiredRoleId;
    if (shouldHave && !currentlyHas) {
      await member.roles.add(roleId, `Patreon sync: ${tier} tier`).catch((e) => {
        console.warn(`[Patreon] Failed to add ${tier} role to ${member.id}:`, e?.message || e);
      });
      added.push(roleId);
    } else if (!shouldHave && currentlyHas) {
      await member.roles.remove(roleId, 'Patreon sync: tier changed/ended').catch((e) => {
        console.warn(`[Patreon] Failed to remove tier role from ${member.id}:`, e?.message || e);
      });
      removed.push(roleId);
    }
  }

  return { added, removed };
}

/** Re-fetches one member fresh from the API and applies their roles. Used by the webhook route. */
export async function syncPatreonMemberById(client: Client, patreonMemberId: string): Promise<PatreonSyncResult> {
  try {
    const apiMember = await fetchCampaignMember(patreonMemberId);
    return applySyncForMember(client, apiMember);
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('HTTP 404') || err.message.includes('not found')) {
      console.log(`[Patreon] Webhook member ${patreonMemberId} not found (404). Cleaning up local record and roles.`);

      const localRecord = await prisma.patreonMember.findUnique({
        where: { patreonMemberId },
      });

      const result: PatreonSyncResult = {
        memberId: patreonMemberId,
        discordId: localRecord?.discordId || null,
        tier: null,
        isActivePatron: false,
        applied: false,
        rolesAdded: [],
        rolesRemoved: [],
      };

      if (localRecord) {
        await prisma.patreonMember.delete({
          where: { patreonMemberId },
        }).catch(() => {});

        if (localRecord.discordId) {
          const guild = client.guilds.cache.get(CONFIG.OWNER_GUILD_ID);
          if (guild) {
            let member: GuildMember | null = null;
            try {
              member = guild.members.cache.get(localRecord.discordId) || await guild.members.fetch(localRecord.discordId);
            } catch {
              member = null;
            }
            if (member) {
              try {
                const { added, removed } = await syncMemberRoles(guild, member, false, null);
                result.rolesAdded = added;
                result.rolesRemoved = removed;
                result.applied = true;
              } catch (e) {
                result.reason = (e as Error).message;
              }
            } else {
              result.reason = 'Member not in home server';
            }
          } else {
            result.reason = 'Owner guild not in cache';
          }
        } else {
          result.reason = 'Local record had no discordId';
        }
      } else {
        result.reason = 'No local record found for this member';
      }
      return result;
    }
    throw error;
  }
}

export interface FullSyncSummary {
  total: number;
  activePatrons: number;
  roled: number;
  unlinked: number;
  errors: number;
  startedAt: Date;
  finishedAt: Date;
}

const MEMBER_SYNC_GAP_MS = 300; // spaces out guild.members.fetch() calls to stay well under rate limits

/** Full campaign reconciliation — pages every member and applies roles one at a time. */
export async function runFullPatreonSync(client: Client): Promise<FullSyncSummary> {
  const startedAt = new Date();
  const summary: FullSyncSummary = {
    total: 0,
    activePatrons: 0,
    roled: 0,
    unlinked: 0,
    errors: 0,
    startedAt,
    finishedAt: startedAt,
  };

  if (!isPatreonConfigured()) {
    console.warn('[Patreon] Sync skipped — PATREON_ACCESS_TOKEN/PATREON_CAMPAIGN_ID not configured.');
    summary.finishedAt = new Date();
    return summary;
  }

  let members: PatreonApiMember[] = [];
  try {
    members = await fetchCampaignMembers();
  } catch (e) {
    console.error('[Patreon] Full sync failed to list campaign members:', (e as Error).message);
    summary.errors++;
    summary.finishedAt = new Date();
    return summary;
  }

  summary.total = members.length;

  for (const m of members) {
    if (m.patronStatus === 'active_patron') summary.activePatrons++;

    let existing = null;
    if (m.patreonUserId) {
      existing = await (prisma as any).patreonMember.findFirst({
        where: { patreonUserId: m.patreonUserId },
      });
    }
    if (!existing) {
      existing = await (prisma as any).patreonMember.findUnique({
        where: { patreonMemberId: m.id },
      });
    }
    if (!m.discordId && existing?.discordId) {
      m.discordId = existing.discordId;
    }

    if (!m.discordId) {
      summary.unlinked++;
      // Still persist the row (discordId null) so /patreon list can surface it to staff.
      await upsertPatreonMemberRow(m, m.patronStatus === 'active_patron' ? resolveTier(m.tierIds) : null);
      continue;
    }
    try {
      const result = await applySyncForMember(client, m);
      if (result.applied && (result.rolesAdded.length || result.rolesRemoved.length)) summary.roled++;
      if (!result.applied && result.reason) {
        console.warn(`[Patreon] Sync skipped for member ${m.id} (${m.fullName}): ${result.reason}`);
      }
    } catch (e) {
      summary.errors++;
      console.error(`[Patreon] Sync failed for member ${m.id}:`, (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, MEMBER_SYNC_GAP_MS));
  }

  summary.finishedAt = new Date();
  console.log(
    `[Patreon] Full sync complete — ${summary.total} member(s), ${summary.activePatrons} active patron(s), ` +
    `${summary.roled} role change(s), ${summary.unlinked} unlinked, ${summary.errors} error(s).`,
  );

  try {
    await prisma.metadata.upsert({
      where: { key: 'lastPatreonSyncSummary' },
      update: { value: JSON.stringify(summary) },
      create: { key: 'lastPatreonSyncSummary', value: JSON.stringify(summary) },
    });
  } catch {
    /* non-fatal — /patreon status just won't show a last-sync line */
  }

  return summary;
}

/** Reads the last full-sync summary persisted by runFullPatreonSync(), for /patreon status. */
export async function getLastSyncSummary(): Promise<FullSyncSummary | null> {
  try {
    const row = await prisma.metadata.findUnique({ where: { key: 'lastPatreonSyncSummary' } });
    if (!row) return null;
    return JSON.parse(row.value) as FullSyncSummary;
  } catch {
    return null;
  }
}

let syncTimer: NodeJS.Timeout | null = null;

/**
 * Starts the periodic reconciliation loop. Call once from the bot's
 * ClientReady handler — mirrors initFileWatcher()'s self-scheduling pattern.
 * No-ops quietly if Patreon isn't configured so this is always safe to call.
 */
export function initPatreonSync(client: Client): void {
  if (!isPatreonConfigured()) {
    console.log('[Patreon] PATREON_ACCESS_TOKEN/PATREON_CAMPAIGN_ID not set — role sync disabled.');
    return;
  }
  if (syncTimer) return; // already running

  const intervalMs = Math.max(5, CONFIG.PATREON_SYNC_INTERVAL_MINUTES) * 60 * 1000;
  console.log(`[Patreon] Role sync enabled — reconciling every ${CONFIG.PATREON_SYNC_INTERVAL_MINUTES}m (plus real-time webhook).`);

  // Give the client a few seconds to finish warming guild/member caches on boot.
  setTimeout(() => {
    runFullPatreonSync(client).catch((e) => console.error('[Patreon] Startup sync failed:', e?.message || e));
  }, 10_000);

  syncTimer = setInterval(() => {
    runFullPatreonSync(client).catch((e) => console.error('[Patreon] Periodic sync failed:', e?.message || e));
  }, intervalMs);
}
