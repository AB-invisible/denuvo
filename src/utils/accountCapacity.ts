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

function envUsageKey(platform: 'ubisoft' | 'ea', day: string): string {
  return `${platform}_env_usage_${day}`;
}

/** Mints via the service env-default account (no BYO row) — tracked in Metadata. */
export async function getEnvPlatformUsageToday(platform: 'ubisoft' | 'ea'): Promise<number> {
  const key = envUsageKey(platform, utcDateKey());
  try {
    const row = await prisma.metadata.findUnique({ where: { key } });
    return row ? Math.max(0, parseInt(row.value, 10) || 0) : 0;
  } catch {
    return 0;
  }
}

export async function incrementEnvPlatformUsage(platform: 'ubisoft' | 'ea'): Promise<void> {
  const today = utcDateKey();
  const key = envUsageKey(platform, today);
  try {
    const row = await prisma.metadata.findUnique({ where: { key } });
    const next = (row ? parseInt(row.value, 10) || 0 : 0) + 1;
    await prisma.metadata.upsert({
      where: { key },
      update: { value: String(next) },
      create: { key, value: String(next) },
    });
  } catch {
    /* non-fatal */
  }
}

export async function markEnvPlatformExhaustedToday(platform: 'ubisoft' | 'ea'): Promise<void> {
  const key = envUsageKey(platform, utcDateKey());
  const cap = String(CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY);
  try {
    await prisma.metadata.upsert({
      where: { key },
      update: { value: cap },
      create: { key, value: cap },
    });
  } catch {
    /* non-fatal */
  }
}

/**
 * Older mints via the service env-default path stored usage in Metadata instead
 * of UbisoftUsage/EaUsage when BYO accounts existed — panel showed 4/5 while
 * 5 activations actually ran. Merge orphan env counts into account rows.
 */
export async function reconcileOrphanEnvUsage(platform: 'ubisoft' | 'ea'): Promise<number> {
  let orphan = await getEnvPlatformUsageToday(platform);
  if (orphan <= 0) return 0;

  const accountTable = platform === 'ubisoft' ? 'ubisoftAccount' : 'eaAccount';
  const usageTable = platform === 'ubisoft' ? 'ubisoftUsage' : 'eaUsage';
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const today = utcDateKey();
  let applied = 0;

  try {
    const rows = await (prisma as any)[accountTable].findMany({
      where: { active: true, guildId: '' },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });

    for (const acct of rows) {
      while (orphan > 0) {
        let used = 0;
        try {
          const u = await (prisma as any)[usageTable].findUnique({
            where: { accountId_usageDate: { accountId: acct.id, usageDate: today } },
          });
          used = u?.count ?? 0;
        } catch {
          used = 0;
        }
        if (used >= cap) break;

        await (prisma as any)[usageTable].upsert({
          where: { accountId_usageDate: { accountId: acct.id, usageDate: today } },
          update: { count: { increment: 1 } },
          create: { accountId: acct.id, usageDate: today, count: used + 1 },
        });
        orphan -= 1;
        applied += 1;
      }
      if (orphan <= 0) break;
    }

    const key = envUsageKey(platform, today);
    if (orphan <= 0) {
      await prisma.metadata.delete({ where: { key } }).catch(() => {});
    } else {
      await prisma.metadata.upsert({
        where: { key },
        update: { value: String(orphan) },
        create: { key, value: String(orphan) },
      });
    }
  } catch {
    return applied;
  }

  return applied;
}

/** Set today's usage for one platform account (staff correction). */
export async function setPlatformAccountUsageToday(
  platform: 'ubisoft' | 'ea',
  accountId: number,
  count: number,
): Promise<void> {
  const usageTable = platform === 'ubisoft' ? 'ubisoftUsage' : 'eaUsage';
  const today = utcDateKey();
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const clamped = Math.max(0, Math.min(cap, count));
  await (prisma as any)[usageTable].upsert({
    where: { accountId_usageDate: { accountId, usageDate: today } },
    update: { count: clamped },
    create: { accountId, usageDate: today, count: clamped },
  });
}

async function sumAccountPoolRemaining(
  table: 'ubisoftAccount' | 'eaAccount',
  usageTable: 'ubisoftUsage' | 'eaUsage',
  guildId: string,
): Promise<{ remaining: number; accountCount: number }> {
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const today = utcDateKey();
  let remaining = 0;
  let accountCount = 0;

  try {
    const where: Record<string, unknown> = { active: true };
    if (guildId) {
      where.OR = [{ guildId: '' }, { guildId }];
    } else {
      where.guildId = '';
    }
    const accounts = await (prisma as any)[table].findMany({ where });
    accountCount = accounts.length;
    for (const acct of accounts) {
      let used = 0;
      try {
        const usage = await (prisma as any)[usageTable].findUnique({
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

  return { remaining, accountCount };
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
  const { remaining, accountCount } = await sumAccountPoolRemaining('ubisoftAccount', 'ubisoftUsage', guildId);

  // Env-default is a fallback slot only when no BYO accounts are registered.
  // Never stack it on top of DB accounts — that inflated the panel (e.g. 1 + 5 = 6).
  if (accountCount === 0 && ubisoftEnvConfigured()) {
    const envUsed = await getEnvPlatformUsageToday('ubisoft');
    return Math.max(0, cap - envUsed);
  }

  return remaining;
}

/** Remaining EA activations today (shared pool across all EA games). */
export async function computeEaRemaining(guildId: string = CONFIG.OWNER_GUILD_ID): Promise<number> {
  if (!usesAccountSyncedStock(guildId)) return CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;

  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const { remaining, accountCount } = await sumAccountPoolRemaining('eaAccount', 'eaUsage', guildId);

  if (accountCount === 0 && eaEnvConfigured()) {
    const envUsed = await getEnvPlatformUsageToday('ea');
    return Math.max(0, cap - envUsed);
  }

  return remaining;
}

/** OPEN/CLAIMED tickets across all games in a shared platform pool. */
export async function countSharedPoolTickets(
  platform: 'ubisoft' | 'ea',
  guildId: string,
): Promise<number> {
  const games = await prisma.game.findMany({
    where: { disabled: false },
    select: { id: true, appId: true, ubisoftAppId: true, eaContentId: true },
  });
  const gameIds = games
    .filter((g) => (platform === 'ubisoft' ? isUbisoftGame(g) : isEaGame(g)))
    .map((g) => g.id);
  if (gameIds.length === 0) return 0;

  const statusFilter = { in: ['OPEN', 'CLAIMED'] as const };
  const where = usesAccountSyncedStock(guildId)
    ? {
        gameId: { in: gameIds },
        status: statusFilter,
        OR: [{ guildId }, { guildId: '' }, { guildId: null }],
      }
    : { gameId: { in: gameIds }, guildId, status: statusFilter };

  return prisma.ticket.count({ where: where as any });
}

/** Read shared Ubisoft/EA pool stock from ServerStock (same value on every title in the pool). */
export async function getSharedPlatformStockFromServer(
  platform: 'ubisoft' | 'ea',
  guildId: string = CONFIG.OWNER_GUILD_ID,
): Promise<number> {
  const games = await prisma.game.findMany({
    where: { disabled: false },
    select: { id: true, appId: true, ubisoftAppId: true, eaContentId: true },
  });
  let best = 0;
  for (const g of games) {
    if (platform === 'ubisoft' ? !isUbisoftGame(g) : !isEaGame(g)) continue;
    const ss = await prisma.serverStock.findUnique({
      where: { gameId_guildId: { gameId: g.id, guildId } },
    });
    if (ss && ss.stock > best) best = ss.stock;
  }
  return best;
}

/** Write the same pool stock to every Ubisoft or EA game row (shared daily pool). */
export async function setSharedPlatformServerStock(
  platform: 'ubisoft' | 'ea',
  guildId: string,
  stock: number,
  lastDepletedAt: Date | null = null,
): Promise<void> {
  const games = await prisma.game.findMany({ where: { disabled: false } });
  for (const g of games) {
    if (platform === 'ubisoft' ? !isUbisoftGame(g) : !isEaGame(g)) continue;
    await prisma.serverStock.upsert({
      where: { gameId_guildId: { gameId: g.id, guildId } },
      update: { stock, lastDepletedAt },
      create: { gameId: g.id, guildId, stock, lastDepletedAt },
    });
  }
}

/**
 * Align today's usage counters so compute*Remaining() matches the target pool
 * stock. Required when staff /settokens — otherwise the next sync overwrites
 * ServerStock back to the old usage-derived value (e.g. set 5, panel shows 1).
 */
export async function alignPlatformUsageToStock(
  platform: 'ubisoft' | 'ea',
  guildId: string,
  stock: number,
): Promise<void> {
  const accountTable = platform === 'ubisoft' ? 'ubisoftAccount' : 'eaAccount';
  const usageTable = platform === 'ubisoft' ? 'ubisoftUsage' : 'eaUsage';
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const today = utcDateKey();
  const envConfigured = platform === 'ubisoft' ? ubisoftEnvConfigured() : eaEnvConfigured();
  const envKey = envUsageKey(platform, today);

  const where: Record<string, unknown> = { active: true };
  if (guildId) {
    where.OR = [{ guildId: '' }, { guildId }];
  } else {
    where.guildId = '';
  }

  let accounts: { id: number }[] = [];
  try {
    accounts = await (prisma as any)[accountTable].findMany({
      where,
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
  } catch {
    accounts = [];
  }

  const totalCapacity = accounts.length > 0 ? accounts.length * cap : (envConfigured ? cap : 0);
  const clampedStock = totalCapacity > 0 ? Math.max(0, Math.min(stock, totalCapacity)) : Math.max(0, stock);
  let usedTotal = Math.max(0, totalCapacity - clampedStock);

  if (accounts.length === 0) {
    if (envConfigured) {
      if (usedTotal <= 0) {
        await prisma.metadata.delete({ where: { key: envKey } }).catch(() => {});
      } else {
        await prisma.metadata.upsert({
          where: { key: envKey },
          update: { value: String(Math.min(cap, usedTotal)) },
          create: { key: envKey, value: String(Math.min(cap, usedTotal)) },
        });
      }
    }
    return;
  }

  await prisma.metadata.delete({ where: { key: envKey } }).catch(() => {});

  for (const acct of accounts) {
    const usedForAcct = Math.min(cap, usedTotal);
    usedTotal -= usedForAcct;
    await (prisma as any)[usageTable].upsert({
      where: { accountId_usageDate: { accountId: acct.id, usageDate: today } },
      update: { count: usedForAcct },
      create: { accountId: acct.id, usageDate: today, count: usedForAcct },
    });
  }
}

/** Staff restock: set shared pool stock and keep usage tables in sync. */
export async function applySharedPlatformStockTarget(
  platform: 'ubisoft' | 'ea',
  guildId: string,
  stock: number,
  lastDepletedAt: Date | null = null,
): Promise<void> {
  await alignPlatformUsageToStock(platform, guildId, stock);
  await setSharedPlatformServerStock(platform, guildId, stock, lastDepletedAt);
}

/** Decrement shared pool stock by one after a mint or manual deduct. */
export async function decrementSharedPlatformServerStock(
  platform: 'ubisoft' | 'ea',
  guildId: string = CONFIG.OWNER_GUILD_ID,
): Promise<number> {
  const current = await getSharedPlatformStockFromServer(platform, guildId);
  const next = Math.max(0, current - 1);
  await setSharedPlatformServerStock(platform, guildId, next, next === 0 ? new Date() : null);
  return next;
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

  // Ubisoft/EA pool stock is staff-managed via /settokens (applySharedPlatformStockTarget).
  if (isUbisoftGame(game) || isEaGame(game)) return requestedAmount;
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

  await syncUbisoftGamesStock(guildId);
  await syncEaGamesStock(guildId);

  return synced;
}

/** Push live Ubisoft pool quota into ServerStock for every Ubisoft game. */
export async function syncUbisoftGamesStock(guildId: string = CONFIG.OWNER_GUILD_ID): Promise<void> {
  if (!usesAccountSyncedStock(guildId)) return;
  await reconcileOrphanEnvUsage('ubisoft');
  const remaining = await computeUbisoftRemaining(guildId);
  await setSharedPlatformServerStock(
    'ubisoft',
    guildId,
    remaining,
    remaining === 0 ? new Date() : null,
  );
}

/** Push live EA pool quota into ServerStock for every EA game. */
export async function syncEaGamesStock(guildId: string = CONFIG.OWNER_GUILD_ID): Promise<void> {
  if (!usesAccountSyncedStock(guildId)) return;
  await reconcileOrphanEnvUsage('ea');
  const remaining = await computeEaRemaining(guildId);
  await setSharedPlatformServerStock('ea', guildId, remaining, remaining === 0 ? new Date() : null);
}

/** Recompute stock for all owner games before panel render (live quotas). */
export async function syncAllOwnerGameStockForPanel(
  guildId: string = CONFIG.OWNER_GUILD_ID,
): Promise<number> {
  if (!usesAccountSyncedStock(guildId)) return 0;

  const games = await prisma.game.findMany({
    where: { disabled: false },
    select: { id: true, appId: true, ubisoftAppId: true, eaContentId: true },
  });

  let synced = 0;
  for (const game of games) {
    // Ubisoft/EA use ServerStock as panel source — updated on mint/deduct/settokens,
    // not overwritten every panel refresh (that broke /settokens).
    if (isUbisoftGame(game) || isEaGame(game)) continue;
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
