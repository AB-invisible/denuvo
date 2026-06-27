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
      return { account: { id: acct.id, login: acct.login, password: acct.password }, exhausted: false };
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

/** Owner /steampass status — each account with today's total usage. */
export async function getPoolStatus(): Promise<
  { id: number; label: string | null; login: string; active: boolean; priority: number; usedToday: number }[]
> {
  const today = utcDateKey();
  const accounts = await (prisma as any).steampassAccount.findMany({
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
  });
  const out = [];
  for (const a of accounts) {
    const agg = await (prisma as any).steampassUsage.aggregate({
      where: { accountId: a.id, usageDate: today },
      _sum: { count: true },
    });
    out.push({ id: a.id, label: a.label, login: a.login, active: a.active, priority: a.priority, usedToday: agg?._sum?.count ?? 0 });
  }
  return out;
}