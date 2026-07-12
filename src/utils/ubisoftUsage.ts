/**
 * Per-Ubisoft-title daily usage counters (5 activations per game per account per UTC day).
 */
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { utcDateKey } from './steampassPool';

export function ubisoftUsageKey(accountId: number, ubisoftAppId: number, usageDate: string) {
  return { accountId_ubisoftAppId_usageDate: { accountId, ubisoftAppId, usageDate } };
}

export async function getUbisoftGameUsageToday(accountId: number, ubisoftAppId: number): Promise<number> {
  const today = utcDateKey();
  try {
    const row = await (prisma as any).ubisoftUsage.findUnique({
      where: ubisoftUsageKey(accountId, ubisoftAppId, today),
    });
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

export async function setUbisoftGameUsageToday(
  accountId: number,
  ubisoftAppId: number,
  count: number,
): Promise<void> {
  const today = utcDateKey();
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const clamped = Math.max(0, Math.min(cap, count));
  await (prisma as any).ubisoftUsage.upsert({
    where: ubisoftUsageKey(accountId, ubisoftAppId, today),
    update: { count: clamped },
    create: { accountId, ubisoftAppId, usageDate: today, count: clamped },
  });
}

export async function incrementUbisoftGameUsage(accountId: number, ubisoftAppId: number): Promise<void> {
  const today = utcDateKey();
  await (prisma as any).ubisoftUsage.upsert({
    where: ubisoftUsageKey(accountId, ubisoftAppId, today),
    update: { count: { increment: 1 } },
    create: { accountId, ubisoftAppId, usageDate: today, count: 1 },
  });
}

export async function markUbisoftGameExhaustedToday(accountId: number, ubisoftAppId: number): Promise<void> {
  await setUbisoftGameUsageToday(accountId, ubisoftAppId, CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY);
}

/** Remaining activations today for one Ubisoft title across all active accounts. */
export async function computeUbisoftRemainingForGame(
  ubisoftAppId: number,
  guildId: string = CONFIG.OWNER_GUILD_ID,
): Promise<number> {
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const where: Record<string, unknown> = { active: true };
  if (guildId && guildId !== CONFIG.OWNER_GUILD_ID) {
    where.OR = [{ guildId: '' }, { guildId }];
  } else {
    where.guildId = '';
  }

  let remaining = 0;
  try {
    const accounts = await (prisma as any).ubisoftAccount.findMany({ where });
    for (const acct of accounts) {
      const used = await getUbisoftGameUsageToday(acct.id, ubisoftAppId);
      remaining += Math.max(0, cap - used);
    }
  } catch {
    /* non-fatal */
  }
  return remaining;
}
