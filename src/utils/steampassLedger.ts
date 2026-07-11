/**
 * steampassLedger.ts — per-endpoint cooldowns + daily API call budget.
 *
 * Humans don't hammer steampass: they log in once, wait a few seconds, click
 * a game, maybe wait again before requesting a guard code. The bot used to fire
 * /profile → /email/code back-to-back across parallel tickets. This ledger
 * enforces minimum gaps BETWEEN individual endpoint calls (not just between
 * whole gens) and caps total steampass API calls per UTC day so we never exceed
 * what a human would do in a busy shift.
 *
 * State is Metadata-backed (survives restarts). All ops are best-effort.
 */

import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { tripSteampassBreaker } from './steampassCircuit';

export type SteampassEndpoint = 'login' | 'profile' | 'guard';

/** Minimum ms between two calls to the same endpoint on the same account. */
const ENDPOINT_COOLDOWN_MS: Record<SteampassEndpoint, number> = {
  // /auth/login is the nuclear option — almost never needed with a cached bearer.
  login: 5 * 60_000,
  // /profile/product-credentials — a human pauses between pages.
  profile: 6_000,
  // /email/code/main — steampass throttles "requested again too soon"; stay conservative.
  guard: 90_000,
};

function utcDateKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function lastCallKey(login: string, endpoint: SteampassEndpoint): string {
  return `steampass_last:${login}:${endpoint}`;
}

function dailyCountKey(date = utcDateKey()): string {
  return `steampass_daily:${date}`;
}

/** How many steampass API calls we've made today (UTC). */
export async function steampassDailyCount(): Promise<number> {
  try {
    const row = await prisma.metadata.findUnique({ where: { key: dailyCountKey() } });
    return parseInt(row?.value || '0', 10) || 0;
  } catch {
    return 0;
  }
}

export async function steampassDailyBudgetRemaining(): Promise<number> {
  const budget = Math.max(1, CONFIG.STEAMPASS_DAILY_BUDGET);
  return Math.max(0, budget - (await steampassDailyCount()));
}

/** True when we've hit the daily steampass call ceiling. */
export async function isSteampassBudgetExhausted(): Promise<boolean> {
  return (await steampassDailyBudgetRemaining()) <= 0;
}

/** Fail fast if we don't have enough daily budget for the calls this gen needs. */
export async function assertSteampassBudget(needed: number, label: string): Promise<boolean> {
  const remaining = await steampassDailyBudgetRemaining();
  if (remaining < needed) {
    console.warn(`[SteampassLedger] Need ${needed} steampass call(s) for ${label} but only ${remaining} left today`);
    await tripSteampassBreaker('insufficient daily steampass budget');
    return false;
  }
  return true;
}

/** Last-call timestamps for Python to human-pace each endpoint before firing. */
export async function getSteampassLedgerJson(login: string): Promise<string> {
  const state: Partial<Record<SteampassEndpoint, string>> = {};
  for (const ep of Object.keys(ENDPOINT_COOLDOWN_MS) as SteampassEndpoint[]) {
    try {
      const row = await prisma.metadata.findUnique({ where: { key: lastCallKey(login, ep) } });
      if (row?.value) state[ep] = row.value;
    } catch { /* skip */ }
  }
  return JSON.stringify(state);
}

/** Cooldown table for Python (ms per endpoint). */
export function steampassCooldownsJson(): string {
  return JSON.stringify(ENDPOINT_COOLDOWN_MS);
}

/** Record that Python made a steampass API call. */
export async function recordSteampassApiCall(
  login: string,
  endpoint: SteampassEndpoint,
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await prisma.metadata.upsert({
      where: { key: lastCallKey(login, endpoint) },
      update: { value: now },
      create: { key: lastCallKey(login, endpoint), value: now },
    });
    const dk = dailyCountKey();
    const row = await prisma.metadata.findUnique({ where: { key: dk } });
    const n = (parseInt(row?.value || '0', 10) || 0) + 1;
    await prisma.metadata.upsert({
      where: { key: dk },
      update: { value: String(n) },
      create: { key: dk, value: String(n) },
    });
  } catch (e) {
    console.warn('[SteampassLedger] record call failed (non-fatal):', (e as Error).message);
  }
}
