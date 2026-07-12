/**
 * ubisoftService.ts — client for the Ubisoft token-minting service
 * (ubisoft-service/, POST /ubisoft/token) plus BYO Ubisoft account rotation
 * and daily-quota tracking.
 *
 * Flow mirrors the Steam side: the bot holds one or more Ubisoft accounts
 * (UbisoftAccount rows, up to OWNER_TOKENS_PER_ACCOUNT_PER_DAY tokens each
 * per UTC day — the Denuvo activation cap). At mint time it tries each
 * account with quota left, then falls back to the service's default
 * UBISOFT_EMAIL/PASSWORD env account (by sending no creds override).
 *
 * The service does the actual Ubisoft login + Uplay demux + Denuvo token
 * generation; this module only orchestrates which account to use and how
 * many times, and turns the ticket (`token_req`) into {token, ownership}.
 */

import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { utcDateKey } from './steampassPool';
import { syncUbisoftGamesStock } from './accountCapacity';

export interface UbisoftMintSuccess {
  ok: true;
  token: string;
  ownership: string;
  accountId: number | null; // which UbisoftAccount was used (null = env default)
  usedAppId: number;
}

export interface UbisoftMintFailure {
  ok: false;
  /** Stable code from the service: ExceededActivations | NotOwned | InvalidRequest | LoginFailed | Failure | Timeout | ServiceUnavailable | NotConfigured */
  code: string;
  error: string;
  logs?: string;
  exhausted?: boolean; // true when every account hit ExceededActivations today
  /** How many BYO accounts had local quota when mint started (0 = env-default only). */
  poolQuotaAtStart?: number;
  /** Last Ubisoft AppID attempted before this failure. */
  usedAppId?: number;
}

export type UbisoftMintResult = UbisoftMintSuccess | UbisoftMintFailure;

export function ubisoftServiceConfigured(): boolean {
  return Boolean((CONFIG.UBISOFT_SERVICE_URL || '').trim() && (CONFIG.UBISOFT_SERVICE_KEY || '').trim());
}

// ── Login-failure cooldown ────────────────────────────────────────────────
// The service does a FULL Ubisoft sign-in on every mint. When Ubisoft starts
// rejecting logins ("too many login attempts"), each retry only renews the
// rate-limit, so it never recovers while users keep submitting. After a
// LoginFailed we pause all Ubisoft mints for a cooldown so the account can
// recover, and short-circuit new mints with a clear "try again shortly".
const UBI_LOGIN_COOLDOWN_MS = Number(process.env.UBISOFT_LOGIN_COOLDOWN_MS || 15 * 60 * 1000);
let ubisoftLoginCooldownUntil = 0;

/** Remaining login cooldown in ms (0 = none). Used by /ubisofthealth and the flow. */
export function ubisoftLoginCooldownRemainingMs(): number {
  return Math.max(0, ubisoftLoginCooldownUntil - Date.now());
}

function tripUbisoftLoginCooldown(): void {
  ubisoftLoginCooldownUntil = Date.now() + UBI_LOGIN_COOLDOWN_MS;
}

function serviceBase(): string {
  return (CONFIG.UBISOFT_SERVICE_URL || '').trim().replace(/\/+$/, '');
}

interface RawServiceResponse {
  token?: string;
  ownership?: string;
  error?: string;
  code?: string;
  logs?: string;
}

/**
 * One HTTP call to the service for a specific appId + optional account
 * credential override. Low-level; callers use mintUbisoftToken() which adds
 * account rotation, quota, and alt-appId fallback.
 */
async function callService(
  ubisoftAppId: number,
  ticket: string,
  creds: { email: string; password: string } | null,
): Promise<{ status: number; body: RawServiceResponse }> {
  const payload: Record<string, unknown> = { ubisoftAppId, ticket };
  if (creds) {
    payload.email = creds.email;
    payload.password = creds.password;
  }

  // Ubisoft login + demux can be slow; give it generous headroom over the
  // service's own 120s tool timeout so we surface the service's error rather
  // than aborting the socket first.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150_000);
  try {
    const res = await fetch(`${serviceBase()}/ubisoft/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Api-Key': (CONFIG.UBISOFT_SERVICE_KEY || '').trim(),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: RawServiceResponse = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: text.slice(0, 300) };
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Active Ubisoft accounts with daily quota left, priority order. */
async function getAvailableUbisoftAccounts(guildId: string): Promise<Array<{ id: number; email: string; password: string }>> {
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const today = utcDateKey();

  let accounts: any[] = [];
  try {
    const where: Record<string, unknown> = { active: true };
    // Owner pool lives under guildId "". Tenant tickets should still use it.
    if (guildId) {
      where.OR = [{ guildId: '' }, { guildId }];
    } else {
      where.guildId = '';
    }
    accounts = await (prisma as any).ubisoftAccount.findMany({
      where,
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
  } catch (e) {
    console.warn('[ubisoftService] account lookup failed (treating as none):', (e as Error).message);
    return [];
  }

  const available: Array<{ id: number; email: string; password: string }> = [];
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
    if (used < cap) {
      available.push({ id: acct.id, email: acct.email, password: acct.password });
    }
  }
  return available;
}

async function recordUbisoftUsage(accountId: number): Promise<void> {
  const today = utcDateKey();
  try {
    await (prisma as any).ubisoftUsage.upsert({
      where: { accountId_usageDate: { accountId, usageDate: today } },
      update: { count: { increment: 1 } },
      create: { accountId, usageDate: today, count: 1 },
    });
    await (prisma as any).ubisoftAccount.update({
      where: { id: accountId },
      data: { lastUsedAt: new Date(), failureCount: 0, lastFailureAt: null },
    });
    await syncUbisoftGamesStock(CONFIG.OWNER_GUILD_ID).catch(() => {});
  } catch (e) {
    console.warn('[ubisoftService] recordUsage failed (non-fatal):', (e as Error).message);
  }
}

async function recordUbisoftFailure(accountId: number): Promise<void> {
  try {
    await (prisma as any).ubisoftAccount.update({
      where: { id: accountId },
      data: { failureCount: { increment: 1 }, lastFailureAt: new Date() },
    });
  } catch {
    /* non-fatal */
  }
}

function mapResult(
  status: number,
  body: RawServiceResponse,
  accountId: number | null,
  usedAppId: number,
): UbisoftMintResult {
  if (status === 200 && body.token) {
    return { ok: true, token: body.token, ownership: body.ownership || '', accountId, usedAppId };
  }
  return {
    ok: false,
    code: body.code || (status === 504 ? 'Timeout' : status === 503 ? 'ServiceUnavailable' : 'Failure'),
    error: body.error || `service returned HTTP ${status}`,
    logs: body.logs,
    usedAppId,
  };
}

/**
 * Mint a Ubisoft token from a `token_req` ticket.
 *
 * Tries, in order:
 *   1. Each BYO UbisoftAccount with daily quota (primary appId, then alt).
 *   2. The service's default env account (creds override omitted).
 *
 * `ExceededActivations` on an account is treated as "this account is spent
 * today" — we mark full usage and rotate. `NotOwned` on the primary appId
 * triggers the alt appId on the same account before rotating.
 */
export async function mintUbisoftToken(
  ubisoftAppId: number,
  altAppId: number | null,
  ticket: string,
  guildId: string,
): Promise<UbisoftMintResult> {
  if (!ubisoftServiceConfigured()) {
    return { ok: false, code: 'NotConfigured', error: 'UBISOFT_SERVICE_URL / UBISOFT_SERVICE_KEY not set' };
  }

  // Back off while Ubisoft is rate-limiting our sign-in — don't hammer it.
  const cooldownMs = ubisoftLoginCooldownRemainingMs();
  if (cooldownMs > 0) {
    const mins = Math.max(1, Math.ceil(cooldownMs / 60000));
    return {
      ok: false,
      code: 'LoginCooldown',
      error: `Ubisoft sign-in is temporarily rate-limited on our side. Try again in ~${mins} min.`,
    };
  }

  const appIds = altAppId && altAppId !== ubisoftAppId ? [ubisoftAppId, altAppId] : [ubisoftAppId];
  const ownerGuildKey = !guildId || guildId === CONFIG.OWNER_GUILD_ID ? '' : guildId;

  const accounts = await getAvailableUbisoftAccounts(ownerGuildKey);
  const poolQuotaAtStart = accounts.length;

  // Build the attempt list: BYO accounts first, then the env-default account
  // (represented by creds=null so the service uses UBISOFT_EMAIL/PASSWORD).
  const attempts: Array<{ id: number | null; creds: { email: string; password: string } | null }> = [
    ...accounts.map((a) => ({ id: a.id as number | null, creds: { email: a.email, password: a.password } })),
    { id: null, creds: null },
  ];

  let anyAccountSeen = accounts.length > 0;
  let allExceeded = anyAccountSeen; // only meaningful if we had accounts
  let lastFailure: UbisoftMintFailure | null = null;

  for (const attempt of attempts) {
    let sawExceededOnThisAccount = false;

    for (const appId of appIds) {
      let resp;
      try {
        resp = await callService(appId, ticket, attempt.creds);
      } catch (e) {
        lastFailure = { ok: false, code: 'ServiceUnavailable', error: (e as Error).message };
        continue;
      }

      const result = mapResult(resp.status, resp.body, attempt.id, appId);
      if (result.ok) {
        if (attempt.id) await recordUbisoftUsage(attempt.id);
        return result;
      }

      lastFailure = { ...result, poolQuotaAtStart };

      // NotOwned on the primary → try the alt appId on the SAME account.
      if (result.code === 'NotOwned') continue;

      // Daily cap — try the alternate build before giving up on this account.
      // Magic files are Steam-based; the wrong AppID can burn activations or
      // return a misleading limit error on the native build ID.
      if (result.code === 'ExceededActivations') {
        sawExceededOnThisAccount = true;
        const appIdx = appIds.indexOf(appId);
        if (appIdx >= 0 && appIdx < appIds.length - 1) continue;
        if (attempt.id) await markAccountExhaustedToday(attempt.id);
        break;
      }

      // LoginFailed / InvalidRequest / Failure / Timeout → bump failure +
      // rotate. InvalidRequest is likely a bad ticket, but another account
      // won't fix that; still, rotating is cheap and safe.
      if (attempt.id) await recordUbisoftFailure(attempt.id);
      break;
    }

    if (attempt.id && !sawExceededOnThisAccount) allExceeded = false;
  }

  if (allExceeded && anyAccountSeen) {
    return {
      ok: false,
      code: 'ExceededActivations',
      error: 'All Ubisoft accounts have hit their daily activation cap.',
      exhausted: true,
      poolQuotaAtStart,
    };
  }

  // A login failure means Ubisoft is rejecting our sign-in (rate-limit / creds /
  // device trust). Trip the cooldown so we stop hammering until it recovers.
  if (lastFailure?.code === 'LoginFailed') tripUbisoftLoginCooldown();

  if (lastFailure) return { ...lastFailure, poolQuotaAtStart };
  return { ok: false, code: 'Failure', error: 'no attempt produced a result', poolQuotaAtStart };
}

/** Force an account's daily counter to the cap so rotation skips it today. */
async function markAccountExhaustedToday(accountId: number): Promise<void> {
  const today = utcDateKey();
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  try {
    await (prisma as any).ubisoftUsage.upsert({
      where: { accountId_usageDate: { accountId, usageDate: today } },
      update: { count: cap },
      create: { accountId, usageDate: today, count: cap },
    });
  } catch {
    /* non-fatal */
  }
}

/** Health probe for /ubisofthealth-style staff commands. */
export async function checkUbisoftServiceHealth(): Promise<{ ok: boolean; tool?: boolean; error?: string }> {
  if (!ubisoftServiceConfigured()) return { ok: false, error: 'not configured' };
  try {
    const res = await fetch(`${serviceBase()}/health`, { headers: { Accept: 'application/json' } });
    const body: any = await res.json().catch(() => ({}));
    return { ok: res.ok && body?.ok === true, tool: body?.tool };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
