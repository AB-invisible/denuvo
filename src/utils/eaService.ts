/**
 * eaService.ts — client for ea-service (POST /ea/token) with BYO EA account
 * rotation, mirroring ubisoftService.ts.
 *
 * ea-service auto-logins with email/password (remid + synthetic pc_sign +
 * machine_hash) and persists trust cookies on its volume — no manual
 * EAtoken_generator / Origin Helper setup required.
 */

import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { utcDateKey } from './steampassPool';
import { syncEaGamesStock, incrementEnvPlatformUsage, markEnvPlatformExhaustedToday } from './accountCapacity';

export interface EaMintSuccess {
  ok: true;
  token: string;
  usedContentId: number;
  usedEngine: string;
  accountId: number | null;
}

export interface EaMintFailure {
  ok: false;
  code: string;
  error: string;
  logs?: string;
  usedContentId?: number;
  usedEngine?: string;
  accountId?: number | null;
  exhausted?: boolean;
  poolQuotaAtStart?: number;
}

export type EaMintResult = EaMintSuccess | EaMintFailure;

export function eaServiceConfigured(): boolean {
  return Boolean((CONFIG.EA_SERVICE_URL || '').trim() && (CONFIG.EA_SERVICE_KEY || '').trim());
}

function serviceBase(): string {
  return (CONFIG.EA_SERVICE_URL || '').trim().replace(/\/+$/, '');
}

interface RawServiceResponse {
  token?: string;
  error?: string;
  code?: string;
  logs?: string;
  detail?: string | RawServiceResponse;
}

function unwrapBody(body: RawServiceResponse): RawServiceResponse {
  if (body.detail && typeof body.detail === 'object') return body.detail;
  if (typeof body.detail === 'string') return { error: body.detail };
  return body;
}

async function callService(
  ticket: string,
  contentId: number,
  engine: string,
  creds: { email: string; password: string } | null,
): Promise<{ status: number; body: RawServiceResponse }> {
  const payload: Record<string, unknown> = { ticket: ticket.trim(), contentId, engine };
  if (creds) {
    payload.email = creds.email;
    payload.password = creds.password;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150_000);
  try {
    const res = await fetch(`${serviceBase()}/ea/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Api-Key': (CONFIG.EA_SERVICE_KEY || '').trim(),
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
    body = unwrapBody(body);
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function getAvailableEaAccounts(guildId: string): Promise<Array<{ id: number; email: string; password: string }>> {
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const today = utcDateKey();

  let accounts: any[] = [];
  try {
    const where: Record<string, unknown> = { active: true };
    if (guildId) {
      where.OR = [{ guildId: '' }, { guildId }];
    } else {
      where.guildId = '';
    }
    accounts = await (prisma as any).eaAccount.findMany({
      where,
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
  } catch {
    return [];
  }

  const out: Array<{ id: number; email: string; password: string }> = [];
  for (const a of accounts) {
    let used = 0;
    try {
      const u = await (prisma as any).eaUsage.findUnique({
        where: { accountId_usageDate: { accountId: a.id, usageDate: today } },
      });
      used = u?.count ?? 0;
    } catch {
      used = 0;
    }
    if (used < cap) out.push({ id: a.id, email: a.email, password: a.password });
  }
  return out;
}

async function recordEaUsage(accountId: number): Promise<void> {
  const today = utcDateKey();
  try {
    await (prisma as any).eaUsage.upsert({
      where: { accountId_usageDate: { accountId, usageDate: today } },
      update: { count: { increment: 1 } },
      create: { accountId, usageDate: today, count: 1 },
    });
    await (prisma as any).eaAccount.update({
      where: { id: accountId },
      data: { lastUsedAt: new Date(), failureCount: 0 },
    });
  } catch {
    /* non-fatal */
  }
}

async function recordEaMintUsage(accountId: number | null): Promise<void> {
  if (accountId) {
    await recordEaUsage(accountId);
    return;
  }

  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const today = utcDateKey();
  try {
    const rows = await (prisma as any).eaAccount.findMany({
      where: { active: true, guildId: '' },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
    for (const acct of rows) {
      let used = 0;
      try {
        const u = await (prisma as any).eaUsage.findUnique({
          where: { accountId_usageDate: { accountId: acct.id, usageDate: today } },
        });
        used = u?.count ?? 0;
      } catch {
        used = 0;
      }
      if (used < cap) {
        await recordEaUsage(acct.id);
        return;
      }
    }
  } catch {
    /* fall through */
  }

  try {
    const rows = await (prisma as any).eaAccount.findMany({
      where: { active: true, guildId: '' },
      select: { id: true },
    });
    for (const acct of rows) {
      await markEaAccountExhaustedToday(acct.id);
    }
    await syncEaGamesStock(CONFIG.OWNER_GUILD_ID).catch(() => {});
  } catch {
    await incrementEnvPlatformUsage('ea');
  }
}

/** Staff close / manual deduct — burn one EA activation slot without minting. */
export async function consumeEaPoolSlot(): Promise<void> {
  await recordEaMintUsage(null);
}

async function recordEaFailure(accountId: number): Promise<void> {
  try {
    await (prisma as any).eaAccount.update({
      where: { id: accountId },
      data: { failureCount: { increment: 1 }, lastFailureAt: new Date() },
    });
  } catch {
    /* non-fatal */
  }
}

async function markEaAccountExhaustedToday(accountId: number): Promise<void> {
  const today = utcDateKey();
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  try {
    await (prisma as any).eaUsage.upsert({
      where: { accountId_usageDate: { accountId, usageDate: today } },
      update: { count: cap },
      create: { accountId, usageDate: today, count: cap },
    });
    await syncEaGamesStock(CONFIG.OWNER_GUILD_ID).catch(() => {});
  } catch {
    /* non-fatal */
  }
}

function mapResult(
  status: number,
  body: RawServiceResponse,
  accountId: number | null,
  contentId: number,
  engine: string,
): EaMintResult {
  if (status === 200 && body.token) {
    return { ok: true, token: body.token, usedContentId: contentId, usedEngine: engine, accountId };
  }
  return {
    ok: false,
    code: body.code || (status === 504 ? 'Timeout' : status === 503 ? 'ServiceUnavailable' : 'Failure'),
    error: body.error || `service returned HTTP ${status}`,
    logs: body.logs,
    usedContentId: contentId,
    usedEngine: engine,
    accountId,
  };
}

export async function mintEaToken(
  ticket: string,
  contentId: number,
  engine: string,
  guildId: string = '',
): Promise<EaMintResult> {
  if (!eaServiceConfigured()) {
    return { ok: false, code: 'NotConfigured', error: 'EA_SERVICE_URL / EA_SERVICE_KEY not set', usedContentId: contentId, usedEngine: engine };
  }

  const ownerGuildKey = !guildId || guildId === CONFIG.OWNER_GUILD_ID ? '' : guildId;
  const accounts = await getAvailableEaAccounts(ownerGuildKey);
  const poolQuotaAtStart = accounts.length;

  const attempts: Array<{ id: number | null; creds: { email: string; password: string } | null }> = [
    ...accounts.map((a) => ({ id: a.id as number | null, creds: { email: a.email, password: a.password } })),
    { id: null, creds: null },
  ];

  let anyAccountSeen = accounts.length > 0;
  let allExceeded = anyAccountSeen;
  let lastFailure: EaMintFailure | null = null;

  for (const attempt of attempts) {
    let sawLimit = false;
    let resp;
    try {
      resp = await callService(ticket, contentId, engine, attempt.creds);
    } catch (e) {
      lastFailure = { ok: false, code: 'ServiceUnavailable', error: (e as Error).message, usedContentId: contentId, usedEngine: engine };
      continue;
    }

    const result = mapResult(resp.status, resp.body, attempt.id, contentId, engine);
    if (result.ok) {
      await recordEaMintUsage(attempt.id);
      return result;
    }

    lastFailure = { ...result, poolQuotaAtStart };

    if (result.code === 'LimitExceeded') {
      sawLimit = true;
      if (attempt.id) await markEaAccountExhaustedToday(attempt.id);
      else await markEnvPlatformExhaustedToday('ea');
      continue;
    }

    if (attempt.id) await recordEaFailure(attempt.id);
    if (result.code === 'NotEntitled') break;
    if (result.code === 'EmailVerificationRequired') break;
    break;
  }

  if (allExceeded && anyAccountSeen) {
    return {
      ok: false,
      code: 'LimitExceeded',
      error: 'All EA accounts have hit their daily activation cap.',
      exhausted: true,
      poolQuotaAtStart,
      usedContentId: contentId,
      usedEngine: engine,
    };
  }

  if (lastFailure) return { ...lastFailure, poolQuotaAtStart };
  return { ok: false, code: 'Failure', error: 'no attempt produced a result', poolQuotaAtStart, usedContentId: contentId, usedEngine: engine };
}

export interface EaLoginActionResult {
  ok: boolean;
  status?: string; // 'logged_in' | 'code_pending' | ...
  email?: string | null;
  message?: string;
  code?: string;
  error?: string;
}

async function postEaLogin(path: string, payload?: Record<string, unknown>): Promise<EaLoginActionResult> {
  if (!eaServiceConfigured()) return { ok: false, error: 'EA service not configured (EA_SERVICE_URL / EA_SERVICE_KEY).' };
  try {
    const res = await fetch(`${serviceBase()}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Api-Key': (CONFIG.EA_SERVICE_KEY || '').trim(),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const text = await res.text();
    let raw: RawServiceResponse & { status?: string; email?: string; message?: string; ok?: boolean } = {};
    try {
      raw = text ? JSON.parse(text) : {};
    } catch {
      raw = { error: text.slice(0, 300) };
    }
    const b = unwrapBody(raw) as typeof raw;
    if (res.status === 409 && (b?.status === 'code_pending' || b?.code === 'EmailCodePending')) {
      return {
        ok: false,
        status: 'code_pending',
        email: (b?.email as string) ?? null,
        message: b?.message || b?.error,
        code: b?.code,
        error: b?.error,
      };
    }
    return {
      ok: res.ok && b?.ok === true,
      status: b?.status,
      email: (b?.email as string) ?? null,
      message: b?.message,
      code: b?.code,
      error: b?.error,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Trigger a fresh login of the env EA account (bot /ealogin). May return code_pending. */
export async function eaLoginStart(): Promise<EaLoginActionResult> {
  return postEaLogin('/ea/login');
}

/** Submit the emailed verification code to finish a pending login (bot /eacode). */
export async function eaSubmitCode(code: string): Promise<EaLoginActionResult> {
  return postEaLogin('/ea/verify-code', { code: code.trim() });
}

/** Import remid cookie from a browser login (bot /easession import). Bypasses captcha. */
export async function eaImportSession(remid: string): Promise<EaLoginActionResult> {
  return postEaLogin('/ea/session/import', { remid: remid.trim() });
}

export async function checkEaServiceHealth(): Promise<{
  ok: boolean;
  tool?: boolean;
  configured?: boolean;
  hasEmailPassword?: boolean;
  sessionEmail?: string | null;
  loginBuild?: string | null;
  error?: string;
}> {
  if (!eaServiceConfigured()) return { ok: false, error: 'not configured' };
  try {
    const res = await fetch(`${serviceBase()}/health`, { headers: { Accept: 'application/json' } });
    const body: any = await res.json().catch(() => ({}));
    return {
      ok: res.ok && body?.ok === true,
      tool: body?.tool,
      configured: body?.configured,
      hasEmailPassword: body?.has_email_password,
      sessionEmail: body?.session_email ?? null,
      loginBuild: body?.login_build ?? null,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
