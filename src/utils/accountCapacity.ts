/**
 * accountCapacity.ts — derive per-game stock from registered account pools.
 *
 * Denuvo allows OWNER_TOKENS_PER_ACCOUNT_PER_DAY (default 5) valid tokens per
 * account per game per UTC day. Stock for each game is the sum of remaining
 * quota from every account that actually owns that game:
 *
 *   SteamAuth links (per appId)
 * + BYO owned Steam accounts (per appId)
 * + Steampass pool accounts linked to that appId (SteampassAccountGame)
 *
 * Owner/home server stock is kept in sync with this capacity. Tenant servers
 * keep manual stock (single steampass account each).
 */

import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { utcDateKey, getPoolAccountIdsForApp, getCachedRefreshTokenPoolAccountIds } from './steampassPool';
import { isUbisoftGame } from './ubisoftCatalog';
import { isEaGame } from './eaCatalog';

function ubisoftEnvConfigured(): boolean {
  return Boolean((CONFIG.UBISOFT_SERVICE_URL || '').trim() && (CONFIG.UBISOFT_SERVICE_KEY || '').trim());
}

function eaEnvConfigured(): boolean {
  return Boolean((CONFIG.EA_SERVICE_URL || '').trim() && (CONFIG.EA_SERVICE_KEY || '').trim());
}

export function usesAccountSyncedStock(guildId: string): boolean {
  return !guildId || guildId === CONFIG.OWNER_GUILD_ID;
}

export interface AccountCapacityBreakdown {
  steamAuth: number;
  owned: number;
  steampassPool: number;
  totalRemaining: number;
  totalCapacity: number;
  /** Active accounts linked to this game (for display). */
  accountCount: number;
}

async function remainingForUsageRecords(
  accountIds: number[],
  cap: number,
  today: string,
  usageModel: 'steampass' | 'owned' | 'steamauth',
  appId?: number,
): Promise<{ remaining: number; capacity: number }> {
  if (accountIds.length === 0) return { remaining: 0, capacity: 0 };

  const capacity = accountIds.length * cap;
  let usedTotal = 0;

  for (const accountId of accountIds) {
    let used = 0;
    try {
      if (usageModel === 'steampass' && appId != null) {
        const usage = await (prisma as any).steampassUsage.findUnique({
          where: { accountId_appId_usageDate: { accountId, appId, usageDate: today } },
        });
        used = usage?.count ?? 0;
      } else if (usageModel === 'owned') {
        const usage = await (prisma as any).ownedSteamUsage.findUnique({
          where: { accountId_usageDate: { accountId, usageDate: today } },
        });
        used = usage?.count ?? 0;
      } else if (usageModel === 'steamauth') {
        const usage = await (prisma as any).steamAuthUsage.findUnique({
          where: { accountId_usageDate: { accountId, usageDate: today } },
        });
        used = usage?.count ?? 0;
      }
    } catch {
      used = 0;
    }
    usedTotal += used;
  }

  return { remaining: Math.max(0, capacity - usedTotal), capacity };
}

/** Remaining valid tokens today for one game on the owner server. */
export async function computeAccountCapacity(
  appId: number,
  guildId: string = CONFIG.OWNER_GUILD_ID,
): Promise<AccountCapacityBreakdown> {
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const today = utcDateKey();
  const guildKey = '';

  if (!usesAccountSyncedStock(guildId)) {
    return {
      steamAuth: 0,
      owned: 0,
      steampassPool: 0,
      totalRemaining: cap,
      totalCapacity: cap,
      accountCount: 1,
    };
  }

  let steamAuthIds: number[] = [];
  let ownedIds: number[] = [];

  try {
    const steamAuthRows = await (prisma as any).steamAuthAccount.findMany({
      where: { guildId: guildKey, appId, active: true },
      select: { id: true },
    });
    steamAuthIds = steamAuthRows.map((r: { id: number }) => r.id);
  } catch { /* table may not exist yet */ }

  try {
    const ownedRows = await (prisma as any).ownedSteamAccount.findMany({
      where: { guildId: guildKey, appId, active: true },
      select: { id: true },
    });
    ownedIds = ownedRows.map((r: { id: number }) => r.id);
  } catch { /* non-fatal */ }

  const poolIds = CONFIG.STEAMPASS_DISABLED
    ? await getCachedRefreshTokenPoolAccountIds(appId, guildKey)
    : await getPoolAccountIdsForApp(appId);

  const steamAuth = await remainingForUsageRecords(steamAuthIds, cap, today, 'steamauth');
  const owned = await remainingForUsageRecords(ownedIds, cap, today, 'owned');
  const steampassPool = await remainingForUsageRecords(poolIds, cap, today, 'steampass', appId);

  const totalRemaining = steamAuth.remaining + owned.remaining + steampassPool.remaining;
  const totalCapacity = steamAuth.capacity + owned.capacity + steampassPool.capacity;
  const accountCount = steamAuthIds.length + ownedIds.length + poolIds.length;

  return {
    steamAuth: steamAuth.remaining,
    owned: owned.remaining,
    steampassPool: steampassPool.remaining,
    totalRemaining,
    totalCapacity,
    accountCount,
  };
}

export async function computeRemainingDailyTokens(
  appId: number,
  guildId: string = CONFIG.OWNER_GUILD_ID,
): Promise<number> {
  const breakdown = await computeAccountCapacity(appId, guildId);
  return breakdown.totalRemaining;
}

/** Remaining Ubisoft activations today (shared pool across all Ubisoft games). */
export async function computeUbisoftRemaining(guildId: string = CONFIG.OWNER_GUILD_ID): Promise<number> {
  if (!usesAccountSyncedStock(guildId)) return CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;

  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const today = utcDateKey();
  let remaining = 0;

  try {
    const where: Record<string, unknown> = { active: true };
    if (guildId) {
      where.OR = [{ guildId: '' }, { guildId }];
    } else {
      where.guildId = '';
    }
    const accounts = await (prisma as any).ubisoftAccount.findMany({ where });
    for (const acct of accounts) {
      let used = 0;
      try {
        const usage = await (prisma as any).ubisoftUsage.findUnique({
          where: { accountId_usageDate: { accountId: acct.id, usageDate: today } },
        });
        used = usage?.count ?? 0;
      } catch {
        used = 0;
      }
      remaining += Math.max(0, cap - used);
    }
  } catch {
    /* table may not exist */
  }

  if (ubisoftEnvConfigured()) {
    remaining += cap;
  }

  return remaining;
}

/** Remaining EA activations today (shared pool across all EA games). */
export async function computeEaRemaining(guildId: string = CONFIG.OWNER_GUILD_ID): Promise<number> {
  if (!usesAccountSyncedStock(guildId)) return CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;

  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const today = utcDateKey();
  let remaining = 0;

  try {
    const where: Record<string, unknown> = { active: true };
    if (guildId) {
      where.OR = [{ guildId: '' }, { guildId }];
    } else {
      where.guildId = '';
    }
    const accounts = await (prisma as any).eaAccount.findMany({ where });
    for (const acct of accounts) {
      let used = 0;
      try {
        const usage = await (prisma as any).eaUsage.findUnique({
          where: { accountId_usageDate: { accountId: acct.id, usageDate: today } },
        });
        used = usage?.count ?? 0;
      } catch {
        used = 0;
      }
      remaining += Math.max(0, cap - used);
    }
  } catch {
    /* table may not exist */
  }

  if (eaEnvConfigured()) {
    remaining += cap;
  }

  return remaining;
}

/** Default stock when seeding ServerStock for a game on the owner server. */
export async function getDefaultStockForApp(appId: number, guildId: string): Promise<number> {
  if (!usesAccountSyncedStock(guildId)) {
    return CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  }
  const breakdown = await computeAccountCapacity(appId, guildId);
  return breakdown.totalCapacity;
}

export interface SyncStockOptions {
  /** When true, set stock to full account capacity even if excludeRegen capped it. */
  forceRaise?: boolean;
  /** Keep current stock when it exceeds the synced value (staff manual restock). */
  preserveManualFloor?: boolean;
}

/**
 * Owner-server manual stock: honour the staff count but never go below live
 * account quota when accounts cover the game (SteamAuth / owned / pool).
 */
export async function resolveOwnerManualStock(
  gameId: number,
  guildId: string,
  requestedAmount: number,
): Promise<number> {
  if (!usesAccountSyncedStock(guildId)) return requestedAmount;

  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) return requestedAmount;

  if (isUbisoftGame(game)) {
    return Math.min(requestedAmount, await computeUbisoftRemaining(guildId));
  }
  if (isEaGame(game)) {
    return Math.min(requestedAmount, await computeEaRemaining(guildId));
  }
  if (!game.appId) return requestedAmount;

  const remaining = await computeRemainingDailyTokens(game.appId, guildId);
  return Math.min(requestedAmount, remaining);
}

/** Push account-derived remaining tokens into ServerStock for one game. */
export async function syncStockForGame(
  gameId: number,
  guildId: string,
  opts: SyncStockOptions = {},
): Promise<number> {
  if (!usesAccountSyncedStock(guildId)) return -1;

  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) return -1;
  if (!game.appId && !isUbisoftGame(game) && !isEaGame(game)) return -1;

  let remaining: number;
  if (isUbisoftGame(game)) {
    remaining = await computeUbisoftRemaining(guildId);
  } else if (isEaGame(game)) {
    remaining = await computeEaRemaining(guildId);
  } else if (!game.appId) {
    return -1;
  } else {
    remaining = await computeRemainingDailyTokens(game.appId, guildId);
  }

  const existing = await prisma.serverStock.findUnique({
    where: { gameId_guildId: { gameId, guildId } },
  });
  const current = existing?.stock ?? remaining;

  // When regen is excluded (or staff manually depleted), never raise stock from
  // account sync — only allow it to drop if quotas are exhausted. forceRaise
  // bypasses this when staff adds a new account source (/steamauth link, etc.).
  let newStock = opts.forceRaise || !game.excludeRegen
    ? remaining
    : Math.min(remaining, current);

  const platformManaged = isUbisoftGame(game) || isEaGame(game);
  if (opts.preserveManualFloor && current > newStock && !platformManaged) {
    newStock = current;
  }

  await prisma.serverStock.upsert({
    where: { gameId_guildId: { gameId, guildId } },
    update: {
      stock: newStock,
      lastDepletedAt: newStock === 0 ? (existing?.lastDepletedAt ?? new Date()) : null,
    },
    create: {
      gameId,
      guildId,
      stock: newStock,
      lastDepletedAt: newStock === 0 ? new Date() : null,
    },
  });

  return newStock;
}

export async function syncStockForAppId(
  appId: number,
  guildId: string = CONFIG.OWNER_GUILD_ID,
  opts: SyncStockOptions = {},
): Promise<number> {
  const game = await prisma.game.findFirst({ where: { appId, disabled: false } });
  if (!game) return -1;
  return syncStockForGame(game.id, guildId, opts);
}

/** Recompute stock for every catalog game on the owner server. */
export async function syncAllOwnerGameStock(
  guildId: string = CONFIG.OWNER_GUILD_ID,
  opts: SyncStockOptions = {},
): Promise<number> {
  if (!usesAccountSyncedStock(guildId)) return 0;

  const games = await prisma.game.findMany({
    where: { disabled: false, appId: { not: null } },
    select: { id: true },
  });

  let synced = 0;
  for (const game of games) {
    await syncStockForGame(game.id, guildId, opts);
    synced++;
  }

  return synced;
}

/** Push live Ubisoft pool quota into ServerStock for every Ubisoft game. */
export async function syncUbisoftGamesStock(guildId: string = CONFIG.OWNER_GUILD_ID): Promise<void> {
  if (!usesAccountSyncedStock(guildId)) return;
  const remaining = await computeUbisoftRemaining(guildId);
  const games = await prisma.game.findMany({ where: { disabled: false } });
  for (const g of games) {
    if (!isUbisoftGame(g)) continue;
    await prisma.serverStock.upsert({
      where: { gameId_guildId: { gameId: g.id, guildId } },
      update: { stock: remaining, lastDepletedAt: remaining === 0 ? new Date() : null },
      create: { gameId: g.id, guildId, stock: remaining, lastDepletedAt: remaining === 0 ? new Date() : null },
    });
  }
}

/** Push live EA pool quota into ServerStock for every EA game. */
export async function syncEaGamesStock(guildId: string = CONFIG.OWNER_GUILD_ID): Promise<void> {
  if (!usesAccountSyncedStock(guildId)) return;
  const remaining = await computeEaRemaining(guildId);
  const games = await prisma.game.findMany({ where: { disabled: false } });
  for (const g of games) {
    if (!isEaGame(g)) continue;
    await prisma.serverStock.upsert({
      where: { gameId_guildId: { gameId: g.id, guildId } },
      update: { stock: remaining, lastDepletedAt: remaining === 0 ? new Date() : null },
      create: { gameId: g.id, guildId, stock: remaining, lastDepletedAt: remaining === 0 ? new Date() : null },
    });
  }
}

/** Recompute stock for all owner games before panel render (live quotas). */
export async function syncAllOwnerGameStockForPanel(
  guildId: string = CONFIG.OWNER_GUILD_ID,
): Promise<number> {
  if (!usesAccountSyncedStock(guildId)) return 0;

  const games = await prisma.game.findMany({
    where: { disabled: false },
    select: { id: true },
  });

  let synced = 0;
  for (const game of games) {
    await syncStockForGame(game.id, guildId);
    synced++;
  }
  return synced;
}

/** How many active accounts can generate for this appId (ignoring usage). */
export async function countAccountSourcesForApp(appId: number): Promise<number> {
  const breakdown = await computeAccountCapacity(appId);
  return breakdown.accountCount;
}
