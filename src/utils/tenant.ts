/**
 * tenant.ts — Multi-tenant resolver.
 *
 * The bot is sold to other Discord servers ("buyer servers" / tenants).
 * Each tenant row in the DB (TenantServer) carries that server's own
 * steampass account plus optional per-server Discord wiring (staff role,
 * ticket category, voucher channel, log channel, tiers, branding).
 *
 * This module is the SINGLE source of truth for "given a guildId, what is
 * the effective config for that server?". Everything else (ticketManager,
 * logging, tokenGenerator, index) calls in here instead of reading the
 * global CONFIG.* env directly, so a buyer server transparently gets its
 * own roles/channels/account while the owner/home server keeps using the
 * global env values.
 *
 * Resolution rule for every field:
 *   tenant row value (if non-null/non-empty)  →  else global CONFIG.* env.
 *
 * The OWNER/home server (CONFIG.OWNER_GUILD_ID) is NEVER a tenant: it
 * always resolves to the global env, and it's the only place the
 * per-server steampass account is the global STEAMPASS_LOGIN/PASSWORD.
 */

import prisma from '../lib/prisma';
import { CONFIG } from '../config';

// Prisma model type is generated; until `prisma generate` runs after the
// schema change, reference it loosely so the project still compiles.
type TenantRow = {
  guildId: string;
  serverName: string;
  inviteLink: string | null;
  steampassLogin: string;
  steampassPassword: string;
  logChannelId: string | null;
  staffRoleId: string | null;
  activatorsRoleId: string | null;
  ticketCategoryId: string | null;
  voucherChannelId: string | null;
  stockNotifChannelId: string | null;
  donatorRoleId: string | null;
  bronzeRoleId: string | null;
  silverRoleId: string | null;
  goldRoleId: string | null;
  botName: string | null;
  patreonUrl: string | null;
  active: boolean;
};

/**
 * The effective, fully-resolved configuration for one guild. Every field
 * is guaranteed present (tenant override or global env fallback).
 */
export interface ServerConfig {
  guildId: string;
  isOwner: boolean;
  /** True for the home server OR an active tenant. False = not allowed. */
  allowed: boolean;
  /** Steampass account used for token generation in this server. */
  steampassLogin: string;
  steampassPassword: string;
  /** Discord wiring. */
  staffRoleId: string;
  activatorsRoleId: string;
  ticketCategoryId: string;
  voucherChannelId: string;
  stockNotifChannelId: string;
  donatorRoleId: string;
  bronzeRoleId: string;
  silverRoleId: string;
  goldRoleId: string;
  /** Detailed-log channel (always the OWNER home channel). */
  ownerLogChannelId: string;
  /** Basic-log channel for THIS server (null for the home server — it
   *  uses the detailed channel and doesn't need a separate basic one). */
  tenantLogChannelId: string | null;
 /** Branding. */
  botName: string;
  patreonUrl: string;
  /** Ready-to-use support-role mention. Owner → home staff role.
   *  Tenant → its own /addsupport role, or '' if unset (so we ping nothing
   *  instead of a broken @home-role mention). */
  staffPing: string;
}

// ─── In-memory cache ─────────────────────────────────────────────
// Tenant rows change rarely (only when the owner runs /addserver,
// /configserver, /removeserver). Cache them so the hot paths
// (every interaction, every message, every panel refresh) don't hit
// the DB. Invalidated explicitly by the owner commands via
// invalidateTenantCache().
let tenantCache: Map<string, TenantRow> | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // safety re-load even without explicit invalidation

async function loadTenants(): Promise<Map<string, TenantRow>> {
  const now = Date.now();
  if (tenantCache && now - cacheLoadedAt < CACHE_TTL_MS) {
    return tenantCache;
  }
  const map = new Map<string, TenantRow>();
  try {
    const rows = (await (prisma as any).tenantServer.findMany()) as TenantRow[];
    for (const r of rows) map.set(r.guildId, r);
  } catch (e) {
    // Table may not exist yet (migration window) — treat as "no tenants".
    console.warn('[tenant] Failed to load TenantServer rows (proceeding with none):', (e as Error).message);
  }
  tenantCache = map;
  cacheLoadedAt = now;
  return map;
}

/** Drop the cache so the next resolve re-reads from the DB. Call after
 *  any owner command that mutates a TenantServer row. */
export function invalidateTenantCache(): void {
  tenantCache = null;
  cacheLoadedAt = 0;
}

/** Is this guild the owner/home server? */
export function isOwnerGuild(guildId: string | null | undefined): boolean {
  return !!guildId && guildId === CONFIG.OWNER_GUILD_ID;
}

/** Get the raw tenant row for a guild, or null. (null for the home server.) */
export async function getTenant(guildId: string): Promise<TenantRow | null> {
  const map = await loadTenants();
  return map.get(guildId) || null;
}

/** Is the bot allowed to operate in this guild? (home OR active tenant) */
export async function isAllowedGuild(guildId: string | null | undefined): Promise<boolean> {
  if (!guildId) return false;
  if (isOwnerGuild(guildId)) return true;
  const t = await getTenant(guildId);
  return !!t && t.active;
}

/** Full list of guild IDs the bot should register commands in + stay in. */
export async function getAllowedGuildIds(): Promise<string[]> {
  const map = await loadTenants();
  const ids = new Set<string>([CONFIG.OWNER_GUILD_ID]);
  for (const [gid, row] of map) if (row.active) ids.add(gid);
  return [...ids];
}

/** All active tenant rows (owner /listservers). */
export async function getAllTenants(): Promise<TenantRow[]> {
  const map = await loadTenants();
  return [...map.values()];
}

const firstNonEmpty = (...vals: (string | null | undefined)[]): string => {
  for (const v of vals) if (v && v.trim()) return v;
  return '';
};

/**
 * Resolve the effective config for a guild. The home server returns the
 * global env values; a tenant returns its overrides with env fallback.
 */
export async function resolveServerConfig(guildId: string): Promise<ServerConfig> {
  const owner = isOwnerGuild(guildId);
  const tenant = owner ? null : await getTenant(guildId);

  return {
    guildId,
    isOwner: owner,
    allowed: owner || (!!tenant && tenant.active),

    // Steampass: home server uses the global env account; a tenant uses
    // its own. (UUIDs are global, so only the account differs.)
    steampassLogin: owner
      ? (process.env.STEAMPASS_LOGIN || '')
      : firstNonEmpty(tenant?.steampassLogin, process.env.STEAMPASS_LOGIN),
    steampassPassword: owner
      ? (process.env.STEAMPASS_PASSWORD || '')
      : firstNonEmpty(tenant?.steampassPassword, process.env.STEAMPASS_PASSWORD),

    staffRoleId: firstNonEmpty(tenant?.staffRoleId, CONFIG.STAFF_ROLE_ID),
    activatorsRoleId: firstNonEmpty(tenant?.activatorsRoleId, tenant?.staffRoleId, CONFIG.ACTIVATORS_ROLE_ID),
    ticketCategoryId: firstNonEmpty(tenant?.ticketCategoryId, CONFIG.TICKET_CATEGORY_ID),
    voucherChannelId: firstNonEmpty(tenant?.voucherChannelId, CONFIG.VOUCHER_CHANNEL_ID),
    stockNotifChannelId: firstNonEmpty(tenant?.stockNotifChannelId, CONFIG.STOCK_NOTIF_CHANNEL_ID),
    donatorRoleId: firstNonEmpty(tenant?.donatorRoleId, CONFIG.DONATOR_ROLE_ID),
    bronzeRoleId: firstNonEmpty(tenant?.bronzeRoleId, CONFIG.BRONZE_ROLE_ID),
    silverRoleId: firstNonEmpty(tenant?.silverRoleId, CONFIG.SILVER_ROLE_ID),
    goldRoleId: firstNonEmpty(tenant?.goldRoleId, CONFIG.GOLD_ROLE_ID),

    // Detailed logs ALWAYS go to the owner home channel.
    ownerLogChannelId: CONFIG.LOG_CHANNEL_ID,
    // Basic per-tenant log channel (null for home server).
    tenantLogChannelId: owner ? null : firstNonEmpty(tenant?.logChannelId) || null,

   botName: firstNonEmpty(tenant?.botName, CONFIG.NAME) || 'GameGen',
    patreonUrl: firstNonEmpty(tenant?.patreonUrl, CONFIG.PATREON_URL),
    staffPing: owner
      ? (CONFIG.STAFF_ROLE_ID ? `<@&${CONFIG.STAFF_ROLE_ID}>` : '')
      : (tenant?.staffRoleId ? `<@&${tenant.staffRoleId}>` : ''),
  };
}
