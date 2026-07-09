/**
 * steampassPool.ts — OWNER-ONLY multi-account steampass rotation.
 *
 * Every steampass account owns every game, but a SINGLE account can only
 * produce OWNER_TOKENS_PER_ACCOUNT_PER_DAY (default 5) WORKING tokens for
 * one game per UTC day — token #6 from the same account comes out invalid
 * (Denuvo per-account daily activation cap). To serve more than 5/day for
 * a game, the bot rotates to the NEXT account, whose copy of that game has
 * its own fresh 5. Total daily capacity for a game = 5 * (active accounts).
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

/**
 * Choose an owner-pool account with remaining daily quota for `appId`.
 * `exhausted` distinguishes "pool empty" (false → caller falls back to the
 * global env account) from "all accounts at cap today" (true → tell the
 * user it resets tomorrow).
 */
export async function pickOwnerAccount(
  appId: number,
): Promise<{ account: PooledAccount | null; exhausted: boolean }> {
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const today = utcDateKey();

  let accounts: any[] = [];
  try {
    accounts = await (prisma as any).steampassAccount.findMany({
      where: { active: true },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
  } catch (e) {
    console.warn('[steampassPool] account lookup failed (treating as empty pool):', (e as Error).message);
    return { account: null, exhausted: false };
  }

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
      return { account: { id: acct.id, login: acct.login, password: acct.password, token: (acct.token || '').trim() }, exhausted: false };
    }
  }

  return { account: null, exhausted: true };
}

/** Increment the per-account/per-game/per-day counter after a SUCCESS only. */
export async function recordOwnerUsage(accountId: number, appId: number): Promise<void> {
  const today = utcDateKey();
  try {
    await (prisma as any).steampassUsage.upsert({
      where: { accountId_appId_usageDate: { accountId, appId, usageDate: today } },
      update: { count: { increment: 1 } },
      create: { accountId, appId, usageDate: today, count: 1 },
    });
  } catch (e) {
    console.warn('[steampassPool] recordOwnerUsage failed (non-fatal):', (e as Error).message);
  }
}

/**
 * Return ALL owner-pool accounts with remaining daily quota for `appId`,
 * in priority order. Used by the retry loop to try each account on failure.
 */
export async function getAllAvailableOwnerAccounts(
  appId: number,
): Promise<{ accounts: PooledAccount[]; exhausted: boolean }> {
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const today = utcDateKey();

  let accounts: any[] = [];
  try {
    accounts = await (prisma as any).steampassAccount.findMany({
      where: { active: true },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
  } catch (e) {
    console.warn('[steampassPool] account lookup failed (treating as empty pool):', (e as Error).message);
    return { accounts: [], exhausted: false };
  }

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
      available.push({ id: acct.id, login: acct.login, password: acct.password, token: (acct.token || '').trim() });
    }
  }

  if (available.length === 0) return { accounts: [], exhausted: true };
  return { accounts: available, exhausted: false };
}

/** Owner /steampass status — each account with today's total usage. */
export async function getPoolStatus(): Promise<
  { id: number; label: string | null; login: string; active: boolean; priority: number; usedToday: number; hasToken: boolean }[]
> {
  const today = utcDateKey();
  const accounts = await (prisma as any).steampassAccount.findMany({
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
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
  } catch {}

  return accounts.map((a: any) => ({
    id: a.id, label: a.label, login: a.login, active: a.active, priority: a.priority,
    usedToday: usageMap.get(a.id) ?? 0,
    hasToken: !!(a.token || '').trim(),
  }));
}