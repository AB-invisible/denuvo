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
import { utcDateKey, getPoolAccountIdsForApp } from './steampassPool';
import { isUbisoftGame } from './ubisoftCatalog';

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

  const poolIds = CONFIG.STEAMPASS_DISABLED ? [] : await getPoolAccountIdsForApp(appId);

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
}

/** Push account-derived remaining tokens into ServerStock for one game. */
export async function syncStockForGame(
  gameId: number,
  guildId: string,
  opts: SyncStockOptions = {},
): Promise<number> {
  if (!usesAccountSyncedStock(guildId)) return -1;

  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game?.appId) return -1;

  // Ubisoft games are delivered via the magic-files pipeline and consume ZERO
  // Steam-account capacity — computeAccountCapacity() would always report 0 for
  // them and force ServerStock to 0, permanently blocking sales. Skip them so
  // their stock stays owner-managed (set via /stock), just like a Steam game.
  if (isUbisoftGame(game)) return -1;

  const remaining = await computeRemainingDailyTokens(game.appId, guildId);
  const existing = await prisma.serverStock.findUnique({
    where: { gameId_guildId: { gameId, guildId } },
  });
  const current = existing?.stock ?? remaining;

  // When regen is excluded (or staff manually depleted), never raise stock from
  // account sync — only allow it to drop if quotas are exhausted. forceRaise
  // bypasses this when staff adds a new account source (/steamauth link, etc.).
  const newStock = opts.forceRaise || !game.excludeRegen
    ? remaining
    : Math.min(remaining, current);

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

/** How many active accounts can generate for this appId (ignoring usage). */
export async function countAccountSourcesForApp(appId: number): Promise<number> {
  const breakdown = await computeAccountCapacity(appId);
  return breakdown.accountCount;
}
