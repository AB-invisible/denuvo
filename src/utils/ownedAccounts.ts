/**
 * ownedAccounts.ts — owner-provided (BYO) Steam accounts.
 *
 * A real Steam account the owner OWNS that already has a specific game. The
 * bot logs into it DIRECTLY (no steampass) and generates up to
 * OWNER_TOKENS_PER_ACCOUNT_PER_DAY tokens per UTC day for its game. Once the
 * day's quota is spent (Denuvo activation cap), gen falls back to the
 * steampass pool. Managed via /steamaccount add|list|remove. Tried after
 * SteamAuth and before steampass.
 */

import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { utcDateKey } from './steampassPool';

export interface OwnedAccount {
  id: number;
  appId: number;
  steamLogin: string;
  steamPassword: string;
  sharedSecret: string; // '' when the account has no Steam Guard
  refreshToken: string;  // '' until the first successful login caches one
}

/**
 * All active owned accounts for (guildId, appId) that still have daily
 * quota left, in priority order. Empty when none exist or all are at cap
 * today — the caller then falls back to the steampass pool.
 */
export async function getAvailableOwnedAccounts(appId: number, guildId: string): Promise<OwnedAccount[]> {
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const today = utcDateKey();

  let accounts: any[] = [];
  try {
    accounts = await (prisma as any).ownedSteamAccount.findMany({
      where: { guildId, appId, active: true },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
  } catch (e) {
    console.warn('[ownedAccounts] lookup failed (treating as none):', (e as Error).message);
    return [];
  }

  const available: OwnedAccount[] = [];
  for (const acct of accounts) {
    let used = 0;
    try {
      const usage = await (prisma as any).ownedSteamUsage.findUnique({
        where: { accountId_usageDate: { accountId: acct.id, usageDate: today } },
      });
      used = usage?.count ?? 0;
    } catch {
      used = 0;
    }
    if (used < cap) {
      available.push({
        id: acct.id,
        appId: acct.appId,
        steamLogin: acct.steamLogin,
        steamPassword: acct.steamPassword,
        sharedSecret: (acct.sharedSecret || '').trim(),
        refreshToken: (acct.refreshToken || '').trim(),
      });
    }
  }
  return available;
}

/** Increment the per-account/per-day counter after a SUCCESS only. */
export async function recordOwnedUsage(accountId: number): Promise<void> {
  const today = utcDateKey();
  try {
    await (prisma as any).ownedSteamUsage.upsert({
      where: { accountId_usageDate: { accountId, usageDate: today } },
      update: { count: { increment: 1 } },
      create: { accountId, usageDate: today, count: 1 },
    });
    await (prisma as any).ownedSteamAccount.update({
      where: { id: accountId },
      data: { lastUsedAt: new Date(), failureCount: 0, lastFailureAt: null },
    });
    const acct = await (prisma as any).ownedSteamAccount.findUnique({
      where: { id: accountId },
      select: { appId: true },
    });
    if (acct?.appId) {
      const { syncStockForAppId } = await import('./accountCapacity');
      await syncStockForAppId(acct.appId).catch(() => {});
    }
  } catch (e) {
    console.warn('[ownedAccounts] recordUsage failed (non-fatal):', (e as Error).message);
  }
}

/** Persist a freshly-captured refresh_token so the next gen skips even the
 * password login. Steam refresh_tokens live ~200 days. */
export async function saveOwnedRefreshToken(accountId: number, refreshToken: string, steamId?: string): Promise<void> {
  if (!refreshToken) return;
  try {
    await (prisma as any).ownedSteamAccount.update({
      where: { id: accountId },
      data: { refreshToken, ...(steamId ? { steamId } : {}) },
    });
  } catch (e) {
    console.warn('[ownedAccounts] saveRefreshToken failed (non-fatal):', (e as Error).message);
  }
}

/** Bump the failure counter on a gen failure (telemetry / staff visibility). */
export async function recordOwnedFailure(accountId: number): Promise<void> {
  try {
    await (prisma as any).ownedSteamAccount.update({
      where: { id: accountId },
      data: { failureCount: { increment: 1 }, lastFailureAt: new Date() },
    });
  } catch {
    /* non-fatal */
  }
}
