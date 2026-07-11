/**
 * steampassPool.ts — OWNER-ONLY multi-account steampass rotation.
 *
 * Pool accounts are linked to specific games via SteampassAccountGame.
 * Stock for a game = 5 × (accounts linked to that game) minus today's usage.
 * Gen rotates through linked accounts that still have daily quota left.
 *
 * Buyer (tenant) servers never call this — they use their single account.
 */

import prisma from '../lib/prisma';
import { CONFIG } from '../config';

export interface PooledAccount {
  id: number;
  login: string;
  password: string;
  token: string;
}

/** UTC "YYYY-MM-DD" for today — the daily-reset bucket key. */
export function utcDateKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Ensure the global env steampass login exists as a pool row (for game links). */
export async function ensureEnvPoolAccount(): Promise<number | null> {
  const login = (process.env.STEAMPASS_LOGIN || '').trim();
  const password = process.env.STEAMPASS_PASSWORD || '';
  if (!login) return null;

  try {
    const acct = await (prisma as any).steampassAccount.upsert({
      where: { login },
      update: {},
      create: { login, password, label: 'env-default', active: true },
    });
    return acct.id as number;
  } catch {
    return null;
  }
}

/** Link a pool account to a game (AppID). Idempotent. */
export async function linkPoolAccountGame(accountId: number, appId: number): Promise<void> {
  try {
    await (prisma as any).steampassAccountGame.upsert({
      where: { accountId_appId: { accountId, appId } },
      update: {},
      create: { accountId, appId },
    });
  } catch (e) {
    console.warn('[steampassPool] linkPoolAccountGame failed:', (e as Error).message);
  }
}

export async function unlinkPoolAccountGame(accountId: number, appId: number): Promise<boolean> {
  try {
    await (prisma as any).steampassAccountGame.delete({
      where: { accountId_appId: { accountId, appId } },
    });
    return true;
  } catch {
    return false;
  }
}

/** Active pool accounts that own `appId` (explicit game link required). */
export async function getPoolAccountsForApp(appId: number): Promise<any[]> {
  try {
    return await (prisma as any).steampassAccount.findMany({
      where: {
        active: true,
        games: { some: { appId } },
      },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
  } catch (e) {
    console.warn('[steampassPool] getPoolAccountsForApp failed:', (e as Error).message);
    return [];
  }
}

/** Pool account IDs linked to this AppID. */
export async function getPoolAccountIdsForApp(appId: number): Promise<number[]> {
  const accounts = await getPoolAccountsForApp(appId);
  return accounts.map((a: { id: number }) => a.id);
}

export interface CachedRefreshTokenCandidate {
  poolAccountId: number | null;
  login: string;
  password: string;
}

/**
 * When steampass API is disabled, find pool/env accounts that still have a
 * saved Steam refresh_token for this game's steampass UUID (SteamSession row).
 */
export async function listCachedRefreshTokenCandidates(
  appId: number,
  guildKey: string = '',
): Promise<CachedRefreshTokenCandidate[]> {
  const game = await prisma.game.findFirst({ where: { appId, disabled: false } });
  if (!game?.steampassUuid) return [];

  let sessions: { steampassLogin: string; refreshToken: string | null }[] = [];
  try {
    sessions = await (prisma as any).steamSession.findMany({
      where: { guildId: guildKey, steampassUuid: game.steampassUuid, refreshToken: { not: null } },
      select: { steampassLogin: true, refreshToken: true },
      orderBy: [{ failureCount: 'asc' }, { lastLoginAt: 'desc' }],
    });
  } catch {
    return [];
  }

  const logins = [
    ...new Set(
      sessions
        .filter((s) => (s.refreshToken || '').trim())
        .map((s) => (s.steampassLogin || '').trim())
        .filter(Boolean),
    ),
  ];
  if (logins.length === 0) return [];

  const candidates: CachedRefreshTokenCandidate[] = [];
  const envLogin = (process.env.STEAMPASS_LOGIN || '').trim();
  const envPassword = process.env.STEAMPASS_PASSWORD || '';

  let tenantLogin = '';
  let tenantPassword = '';
  if (guildKey) {
    try {
      const { resolveServerConfig } = await import('./tenant');
      const sc = await resolveServerConfig(guildKey);
      tenantLogin = (sc.steampassLogin || '').trim();
      tenantPassword = sc.steampassPassword || '';
    } catch {
      /* non-fatal */
    }
  }

  for (const login of logins) {
    let poolAccountId: number | null = null;
    let password = '';
    try {
      const acct = await (prisma as any).steampassAccount.findUnique({ where: { login } });
      if (acct) {
        poolAccountId = acct.id as number;
        password = acct.password || '';
      } else if (!guildKey && login === envLogin) {
        password = envPassword;
      } else if (guildKey && login === tenantLogin) {
        password = tenantPassword;
      } else {
        continue;
      }
    } catch {
      continue;
    }
    candidates.push({ poolAccountId, login, password });
  }

  return candidates;
}

/** Pool account IDs that can still gen via cached refresh_token when steampass is off. */
export async function getCachedRefreshTokenPoolAccountIds(
  appId: number,
  guildKey: string = '',
): Promise<number[]> {
  const candidates = await listCachedRefreshTokenCandidates(appId, guildKey);
  return candidates.map((c) => c.poolAccountId).filter((id): id is number => id != null);
}

/** Pool accounts with cached refresh_token and remaining daily quota for this game. */
export async function getAvailableCachedRefreshTokenAccounts(
  appId: number,
  guildKey: string = '',
): Promise<{ accounts: PooledAccount[]; exhausted: boolean }> {
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const today = utcDateKey();
  const candidates = await listCachedRefreshTokenCandidates(appId, guildKey);
  if (candidates.length === 0) return { accounts: [], exhausted: false };

  const available: PooledAccount[] = [];
  for (const cand of candidates) {
    if (!cand.poolAccountId) {
      available.push({ id: -1, login: cand.login, password: cand.password, token: '' });
      continue;
    }
    let used = 0;
    try {
      const usage = await (prisma as any).steampassUsage.findUnique({
        where: { accountId_appId_usageDate: { accountId: cand.poolAccountId, appId, usageDate: today } },
      });
      used = usage?.count ?? 0;
    } catch {
      used = 0;
    }
    if (used < cap) {
      try {
        const acct = await (prisma as any).steampassAccount.findUnique({ where: { id: cand.poolAccountId } });
        available.push({
          id: cand.poolAccountId,
          login: cand.login,
          password: cand.password,
          token: (acct?.token || '').trim(),
        });
      } catch {
        /* skip */
      }
    }
  }

  if (available.length === 0) return { accounts: [], exhausted: true };
  return { accounts: available, exhausted: false };
}

/** Backfill game links from historical successful usage rows. */
export async function migrateGameLinksFromUsage(): Promise<number> {
  let linked = 0;
  try {
    const pairs = await (prisma as any).steampassUsage.findMany({
      select: { accountId: true, appId: true },
      distinct: ['accountId', 'appId'],
    });
    for (const row of pairs) {
      await linkPoolAccountGame(row.accountId, row.appId);
      linked++;
    }
  } catch (e) {
    console.warn('[steampassPool] migrateGameLinksFromUsage failed:', (e as Error).message);
  }
  return linked;
}

export async function listPoolAccountGames(accountId: number): Promise<number[]> {
  try {
    const rows = await (prisma as any).steampassAccountGame.findMany({
      where: { accountId },
      select: { appId: true },
      orderBy: { appId: 'asc' },
    });
    return rows.map((r: { appId: number }) => r.appId);
  } catch {
    return [];
  }
}

export async function linkAllCatalogGamesToAccount(accountId: number): Promise<number> {
  const games = await prisma.game.findMany({
    where: { disabled: false, appId: { not: null } },
    select: { appId: true },
  });
  let count = 0;
  for (const g of games) {
    if (g.appId) {
      await linkPoolAccountGame(accountId, g.appId);
      count++;
    }
  }
  return count;
}

/**
 * Choose an owner-pool account with remaining daily quota for `appId`.
 * Only considers accounts explicitly linked to that game.
 */
export async function pickOwnerAccount(
  appId: number,
): Promise<{ account: PooledAccount | null; exhausted: boolean }> {
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const today = utcDateKey();

  const accounts = await getPoolAccountsForApp(appId);
  if (accounts.length === 0) return { account: null, exhausted: false };

  for (const acct of accounts) {
    let used = 0;
    try {
      const usage = await (prisma as any).steampassUsage.findUnique({
        where: { accountId_appId_usageDate: { accountId: acct.id, appId, usageDate: today } },
      });
      used = usage?.count ?? 0;
    } catch {
      used = 0;
    }
    if (used < cap) {
      return {
        account: {
          id: acct.id,
          login: acct.login,
          password: acct.password,
          token: (acct.token || '').trim(),
        },
        exhausted: false,
      };
    }
  }

  return { account: null, exhausted: true };
}

/** Increment the per-account/per-game/per-day counter after a SUCCESS only. */
export async function recordOwnerUsage(accountId: number, appId: number): Promise<void> {
  const today = utcDateKey();
  try {
    await linkPoolAccountGame(accountId, appId);
    await (prisma as any).steampassUsage.upsert({
      where: { accountId_appId_usageDate: { accountId, appId, usageDate: today } },
      update: { count: { increment: 1 } },
      create: { accountId, appId, usageDate: today, count: 1 },
    });
    const { syncStockForAppId } = await import('./accountCapacity');
    await syncStockForAppId(appId).catch(() => {});
  } catch (e) {
    console.warn('[steampassPool] recordOwnerUsage failed (non-fatal):', (e as Error).message);
  }
}

/**
 * Return ALL owner-pool accounts linked to `appId` with remaining daily quota,
 * in priority order. Used by the retry loop to try each account on failure.
 */
export async function getAllAvailableOwnerAccounts(
  appId: number,
): Promise<{ accounts: PooledAccount[]; exhausted: boolean }> {
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const today = utcDateKey();

  const accounts = await getPoolAccountsForApp(appId);
  if (accounts.length === 0) return { accounts: [], exhausted: false };

  const available: PooledAccount[] = [];
  for (const acct of accounts) {
    let used = 0;
    try {
      const usage = await (prisma as any).steampassUsage.findUnique({
        where: { accountId_appId_usageDate: { accountId: acct.id, appId, usageDate: today } },
      });
      used = usage?.count ?? 0;
    } catch {
      used = 0;
    }
    if (used < cap) {
      available.push({
        id: acct.id,
        login: acct.login,
        password: acct.password,
        token: (acct.token || '').trim(),
      });
    }
  }

  if (available.length === 0) return { accounts: [], exhausted: true };
  return { accounts: available, exhausted: false };
}

/** Owner /steampass status — each account with today's total usage + game count. */
export async function getPoolStatus(): Promise<
  {
    id: number;
    label: string | null;
    login: string;
    active: boolean;
    priority: number;
    usedToday: number;
    gameCount: number;
    hasToken: boolean;
  }[]
> {
  const today = utcDateKey();
  const accounts = await (prisma as any).steampassAccount.findMany({
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    include: { _count: { select: { games: true } } },
  });
  if (!accounts.length) return [];

  const accountIds = accounts.map((a: any) => a.id);
  let usageMap = new Map<number, number>();
  try {
    const usages = await (prisma as any).steampassUsage.groupBy({
      by: ['accountId'],
      where: { accountId: { in: accountIds }, usageDate: today },
      _sum: { count: true },
    });
    for (const u of usages) {
      usageMap.set(u.accountId, u._sum?.count ?? 0);
    }
  } catch { /* non-fatal */ }

  return accounts.map((a: any) => ({
    id: a.id,
    label: a.label,
    login: a.login,
    active: a.active,
    priority: a.priority,
    usedToday: usageMap.get(a.id) ?? 0,
    gameCount: a._count?.games ?? 0,
    hasToken: !!(a.token || '').trim(),
  }));
}

/** How many active pool accounts are linked to this AppID. */
export async function countPoolAccountsForApp(appId: number): Promise<number> {
  try {
    return await (prisma as any).steampassAccount.count({
      where: { active: true, games: { some: { appId } } },
    });
  } catch {
    return 0;
  }
}
