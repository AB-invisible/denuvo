/**
 * guildAccess.ts — central "is the bot allowed to act in this guild?" gate.
 *
 * Used by index.ts for the server-lock (ClientReady sweep, GuildCreate,
 * and the per-interaction guard). Wraps the tenant resolver so the lock
 * logic lives in one place:
 *
 *   - OWNER_GUILD_ID (home)         → always allowed
 *   - active TenantServer row        → allowed
 *   - paused TenantServer (active=false) → NOT allowed, but DO NOT leave
 *     the guild (suspended for non-payment; flip back with /resumeserver)
 *   - no row at all                  → not allowed AND safe to leave
 */

import { CONFIG } from '../config';
import { getTenant, isOwnerGuild } from './tenant';

export type GuildVerdict =
  | { allowed: true; reason: 'owner' | 'tenant' }
  | { allowed: false; reason: 'paused' | 'unknown' };

export async function checkGuild(guildId: string | null | undefined): Promise<GuildVerdict> {
  if (!guildId) return { allowed: false, reason: 'unknown' };
  if (isOwnerGuild(guildId)) return { allowed: true, reason: 'owner' };

  const tenant = await getTenant(guildId);
  if (!tenant) return { allowed: false, reason: 'unknown' };
  if (!tenant.active) return { allowed: false, reason: 'paused' };
  return { allowed: true, reason: 'tenant' };
}

/** Should the bot physically leave this guild? Only truly-unknown guilds.
 *  Paused tenants are kept (suspended, not evicted). */
export async function shouldLeaveGuild(guildId: string | null | undefined): Promise<boolean> {
  const v = await checkGuild(guildId);
  return !v.allowed && v.reason === 'unknown';
}