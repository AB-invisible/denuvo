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
import {
  incrementEnvPlatformUsage,
  markEnvPlatformExhaustedToday,
} from './accountCapacity';
import {
  getUbisoftGameUsageToday,
  incrementUbisoftGameUsage,
  markUbisoftGameExhaustedToday,
} from './ubisoftUsage';

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

/** Active Ubisoft accounts with daily quota left for one title, priority order. */
async function getAvailableUbisoftAccounts(
  guildId: string,
  ubisoftAppId: number,
): Promise<Array<{ id: number; email: string; password: string }>> {
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;

  let accounts: any[] = [];
  try {
    const where: Record<string, unknown> = { active: true };
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
    const used = await getUbisoftGameUsageToday(acct.id, ubisoftAppId);
    if (used < cap) {
      available.push({ id: acct.id, email: acct.email, password: acct.password });
    }
  }
  return available;
}

async function recordUbisoftUsage(accountId: number, ubisoftAppId: number): Promise<void> {
  try {
    await incrementUbisoftGameUsage(accountId, ubisoftAppId);
    await (prisma as any).ubisoftAccount.update({
      where: { id: accountId },
      data: { lastUsedAt: new Date(), failureCount: 0, lastFailureAt: null },
    });
  } catch (e) {
    console.warn('[ubisoftService] recordUsage failed (non-fatal):', (e as Error).message);
  }
}

/** Attribute one activation to an account (or env fallback) for a specific title. */
async function recordUbisoftMintUsage(accountId: number | null, ubisoftAppId: number): Promise<void> {
  if (accountId) {
    await recordUbisoftUsage(accountId, ubisoftAppId);
    return;
  }

  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  try {
    const rows = await (prisma as any).ubisoftAccount.findMany({
      where: { active: true, guildId: '' },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
    for (const acct of rows) {
      const used = await getUbisoftGameUsageToday(acct.id, ubisoftAppId);
      if (used < cap) {
        await recordUbisoftUsage(acct.id, ubisoftAppId);
        return;
      }
    }
  } catch {
    /* fall through */
  }

  try {
    const rows = await (prisma as any).ubisoftAccount.findMany({
      where: { active: true, guildId: '' },
      select: { id: true },
    });
    for (const acct of rows) {
      await markAccountExhaustedToday(acct.id, ubisoftAppId);
    }
  } catch {
    await incrementEnvPlatformUsage('ubisoft', ubisoftAppId);
  }
}

/** Staff close / manual deduct — burn one slot for this Ubisoft title without minting. */
export async function consumeUbisoftPoolSlot(ubisoftAppId: number): Promise<void> {
  await recordUbisoftMintUsage(null, ubisoftAppId);
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

/** Force an account's daily counter to the cap for one title so rotation skips it today. */
async function markAccountExhaustedToday(accountId: number, ubisoftAppId: number): Promise<void> {
  try {
    await markUbisoftGameExhaustedToday(accountId, ubisoftAppId);
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
 * Which of a game's two Ubisoft builds the account actually owns, learned at
 * runtime and persisted in Metadata. A Denuvo token_req is single-use, so we
 * must NOT spend it on a build the account doesn't own — try the known-owned
 * one first. Keyed by the configured primary appId (stable per game).
 */
async function getCachedOwnedAppId(primaryAppId: number): Promise<number | null> {
  try {
    const m = await prisma.metadata.findUnique({ where: { key: `ubiOwnedAppId:${primaryAppId}` } });
    const v = m ? parseInt(m.value, 10) : NaN;
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

async function cacheOwnedAppId(primaryAppId: number, ownedAppId: number): Promise<void> {
  try {
    await prisma.metadata.upsert({
      where: { key: `ubiOwnedAppId:${primaryAppId}` },
      update: { value: String(ownedAppId) },
      create: { key: `ubiOwnedAppId:${primaryAppId}`, value: String(ownedAppId) },
    });
  } catch {
    /* non-fatal */
  }
}

/**
 * Mint a Ubisoft token from a single-use `token_req` ticket.
 *
 * A Denuvo token_req can be submitted to Ubisoft exactly ONCE — the moment it
 * hits an owned build it is spent. So we:
 *   1. Try the known-owned appId first (cached), never wasting the ticket on a
 *      build the account doesn't own.
 *   2. Rotate to the next account ONLY when every appId came back NotOwned
 *      (ownership is checked before the ticket is spent, so it's still good).
 *      Any other result means the ticket is now spent — we stop and report it.
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

  const configured = altAppId && altAppId !== ubisoftAppId ? [ubisoftAppId, altAppId] : [ubisoftAppId];
  // Known-owned build first — never spend the single-use ticket on a build the
  // account doesn't own.
  const owned = await getCachedOwnedAppId(ubisoftAppId);
  const appIds = owned && configured.includes(owned)
    ? [owned, ...configured.filter((a) => a !== owned)]
    : configured;

  const ownerGuildKey = !guildId || guildId === CONFIG.OWNER_GUILD_ID ? '' : guildId;

  const accounts = await getAvailableUbisoftAccounts(ownerGuildKey, ubisoftAppId);
  const poolQuotaAtStart = accounts.length;

  // Build the attempt list: BYO accounts first, then the env-default account
  // (represented by creds=null so the service uses UBISOFT_EMAIL/PASSWORD).
  const attempts: Array<{ id: number | null; creds: { email: string; password: string } | null }> = [
    ...accounts.map((a) => ({ id: a.id as number | null, creds: { email: a.email, password: a.password } })),
    { id: null, creds: null },
  ];

  let lastFailure: UbisoftMintFailure | null = null;

  for (const attempt of attempts) {
    let ticketSpent = false;

    for (const appId of appIds) {
      let resp;
      try {
        resp = await callService(appId, ticket, attempt.creds);
      } catch (e) {
        lastFailure = { ok: false, code: 'ServiceUnavailable', error: (e as Error).message };
        break; // couldn't reach the service — the ticket likely wasn't spent; try next account
      }

      const result = mapResult(resp.status, resp.body, attempt.id, appId);
      if (result.ok) {
        await recordUbisoftMintUsage(attempt.id, result.usedAppId);
        await cacheOwnedAppId(ubisoftAppId, result.usedAppId); // learn the owned build
        return result;
      }

      lastFailure = { ...result, poolQuotaAtStart };
      console.warn(
        `[ubisoftService] mint failed appId=${appId} acct=${attempt.id ?? 'env'} code=${result.code} — ${(result.logs || result.error || '').slice(-220).replace(/\s+/g, ' ')}`,
      );

      // NotOwned: ownership is checked BEFORE the ticket is spent, so it's still
      // good. In a 2-build setup the other build is the owned one — remember it
      // and try it.
      if (result.code === 'NotOwned') {
        const other = configured.find((a) => a !== appId);
        if (other) await cacheOwnedAppId(ubisoftAppId, other);
        continue;
      }

      // Any other result: the token_req was submitted to an OWNED build and is
      // now SPENT (single-use). Re-sending it — alt appId or another account —
      // just dies on a used ticket and can burn extra activations. Stop.
      ticketSpent = true;
      if (result.code === 'ExceededActivations') {
        if (attempt.id) await markAccountExhaustedToday(attempt.id, appId);
        else await markEnvPlatformExhaustedToday('ubisoft', appId);
      } else if (attempt.id) {
        await recordUbisoftFailure(attempt.id);
      }
      break;
    }

    // Only move to the next account when the ticket is still unspent (every
    // appId came back NotOwned — this account owns none of the builds).
    if (ticketSpent) break;
  }

  // A login failure means Ubisoft is rejecting our sign-in (rate-limit / creds /
  // device trust). Trip the cooldown so we stop hammering until it recovers.
  if (lastFailure?.code === 'LoginFailed') tripUbisoftLoginCooldown();

  if (lastFailure?.code === 'ExceededActivations') {
    return { ...lastFailure, exhausted: true, poolQuotaAtStart };
  }
  if (lastFailure) return { ...lastFailure, poolQuotaAtStart };
  return { ok: false, code: 'Failure', error: 'no attempt produced a result', poolQuotaAtStart };
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
