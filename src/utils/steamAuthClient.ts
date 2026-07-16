/**
 * steamAuthClient.ts — HTTP client for GameGen Auth Service
 * (https://steamauth.gamegen.lol/docs).
 *
 * Preferred bot flow (API key only — no Steam password on the bot):
 *   1. GET /health — liveness
 *   2. GET /api/v1/accounts — list accounts + games (pick account_id UUID)
 *   3. GET /api/v1/accounts/:account_id/credentials — login + guard in one call
 *      — or GET /api/v1/accounts/:account_id/guard-code when refresh_token is cached
 *
 * Legacy POST /api/v1/guard-code (requires Steam password) is kept as fallback only.
 */

import { CONFIG } from '../config';

export interface SteamAuthApiGame {
  app_id: number;
  name: string;
  icon_url?: string | null;
}

export interface SteamAuthApiAccount {
  account_id: string;
  url?: string;
  steam_username: string;
  steam_id?: string | null;
  avatar_url?: string | null;
  main_game?: string | null;
  subsidiary_names?: string[];
  games?: SteamAuthApiGame[];
  games_count?: number;
  games_sync_status?: string;
  games_sync_error?: string | null;
  games_synced_at?: string | null;
  has_steam_guard?: boolean;
  guard_revoked?: boolean;
  code?: string | null;
  expires_in?: number | null;
  created_at?: string;
}

export interface SteamAuthGuardCode {
  account_id: string;
  steam_username: string;
  has_steam_guard: boolean;
  guard_revoked: boolean;
  code: string | null;
  expires_in: number | null;
}

export interface SteamAuthCredentials {
  account_id: string;
  steam_username: string;
  password: string;
  has_steam_guard: boolean;
  guard_revoked: boolean;
  code: string | null;
  expires_in: number | null;
}

export interface SteamAuthHealth {
  status: string;
  uptime: number;
}

export interface SteamAuthSyncGamesResult {
  ok: boolean;
  account_id: string;
  games_sync_status: string;
}

function baseUrl(): string {
  return (CONFIG.STEAMAUTH_API_URL || 'https://steamauth.gamegen.lol').replace(/\/$/, '');
}

function apiKey(): string {
  return (CONFIG.STEAMAUTH_API_KEY || '').trim();
}

function parseJsonResponse(text: string): any {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function publicRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  const data = parseJsonResponse(text);

  if (!res.ok) {
    const msg = typeof data?.error === 'string' ? data.error : text.slice(0, 300) || res.statusText;
    throw new Error(`SteamAuth API ${path} failed: HTTP ${res.status} — ${msg}`);
  }
  return data as T;
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = apiKey();
  if (!key) {
    throw new Error('STEAMAUTH_API_KEY is not configured');
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Api-Key': key,
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${baseUrl()}${path}`, { ...init, headers });
  const text = await res.text();
  const data = parseJsonResponse(text);

  if (!res.ok) {
    const msg = typeof data?.error === 'string' ? data.error : text.slice(0, 300) || res.statusText;
    throw new Error(`SteamAuth API ${path} failed: HTTP ${res.status} — ${msg}`);
  }
  return data as T;
}

/** True when the account can return a live guard code via the API. */
export function accountCanProvideGuardCode(account: Pick<SteamAuthApiAccount, 'has_steam_guard' | 'guard_revoked'>): boolean {
  if (account.guard_revoked === true) return false;
  if (account.has_steam_guard === false) return false;
  return true;
}

/**
 * True when the account is safe to use for login. Accounts with no shared
 * secret (has_steam_guard: false) simply don't need a code at login — that's
 * not an error, so they stay usable. Only a revoked Guard actually blocks it.
 */
export function accountUsableForAuth(account: Pick<SteamAuthApiAccount, 'has_steam_guard' | 'guard_revoked'>): boolean {
  return account.guard_revoked !== true;
}

function guardUnavailableReason(data: Pick<SteamAuthGuardCode, 'has_steam_guard' | 'guard_revoked'>): string {
  if (data.guard_revoked) return 'SteamAuth account has Guard revoked on the service';
  if (!data.has_steam_guard) return 'SteamAuth account has no shared secret (has_steam_guard: false)';
  return 'SteamAuth guard-code response missing code';
}

function normalizeCredentialsPayload(data: any, accountId: string): SteamAuthCredentials {
  if (!data || typeof data !== 'object') {
    throw new Error(`SteamAuth credentials response was not JSON (account ${accountId})`);
  }

  const steam_username = String(data.steam_username ?? data.steamUsername ?? '').trim();
  const password = String(data.password ?? '').trim();

  return {
    account_id: String(data.account_id ?? data.accountId ?? accountId),
    steam_username,
    password,
    has_steam_guard: data.has_steam_guard !== false,
    guard_revoked: data.guard_revoked === true,
    code: typeof data.code === 'string' ? data.code : null,
    expires_in: typeof data.expires_in === 'number' ? data.expires_in : null,
  };
}

function credentialsValidationError(data: SteamAuthCredentials): string {
  const missing: string[] = [];
  if (!data.steam_username) missing.push('steam_username');
  if (!data.password) missing.push('password');
  if (missing.length > 0) {
    return (
      `SteamAuth credentials missing ${missing.join(' and ')} for \`${data.steam_username || data.account_id}\` — ` +
      're-save the Steam password on https://steamauth.gamegen.lol/dashboard (PATCH account or re-import maFile).'
    );
  }
  if (data.guard_revoked) return guardUnavailableReason(data);
  if (data.has_steam_guard && !data.code) return guardUnavailableReason(data);
  return '';
}

export function isSteamAuthConfigured(): boolean {
  return Boolean(apiKey());
}

export async function listSteamAuthAccounts(): Promise<SteamAuthApiAccount[]> {
  const data = await apiRequest<SteamAuthApiAccount[] | { accounts?: SteamAuthApiAccount[] }>('/api/v1/accounts');
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.accounts)) return data.accounts;
  return [];
}

export async function getSteamAuthAccount(accountId: string): Promise<SteamAuthApiAccount> {
  return apiRequest<SteamAuthApiAccount>(`/api/v1/accounts/${encodeURIComponent(accountId)}`);
}

/** Recommended: API key only, no Steam password required. */
export async function fetchSteamAuthGuardCode(accountId: string): Promise<SteamAuthGuardCode> {
  const data = await apiRequest<SteamAuthGuardCode>(
    `/api/v1/accounts/${encodeURIComponent(accountId)}/guard-code`,
  );
  if (data.guard_revoked) {
    throw new Error(guardUnavailableReason(data));
  }
  if (data.has_steam_guard && !data.code) {
    throw new Error(guardUnavailableReason(data));
  }
  return data;
}

/** Full login material in one call — username, password, and current guard code. */
export async function fetchSteamAuthCredentials(accountId: string): Promise<SteamAuthCredentials> {
  const raw = await apiRequest<any>(
    `/api/v1/accounts/${encodeURIComponent(accountId)}/credentials`,
  );
  const data = normalizeCredentialsPayload(raw, accountId);
  const err = credentialsValidationError(data);
  if (err) throw new Error(err);
  return data;
}

/** Quick probe before linking — ensures guard + password are available via API. */
export async function validateSteamAuthAccountForGen(accountId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const api = await getSteamAuthAccount(accountId);
    if (!accountUsableForAuth(api)) {
      return { ok: false, reason: 'Guard revoked on the service' };
    }
    await fetchSteamAuthCredentials(accountId);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Trigger async Steam library sync for an account (POST /api/v1/accounts/:id/sync-games). */
export async function syncSteamAuthGames(accountId: string): Promise<SteamAuthSyncGamesResult> {
  return apiRequest<SteamAuthSyncGamesResult>(
    `/api/v1/accounts/${encodeURIComponent(accountId)}/sync-games`,
    { method: 'POST' },
  );
}

/** @deprecated Legacy endpoint — requires Steam password. Use fetchSteamAuthGuardCode or fetchSteamAuthCredentials. */
export async function fetchSteamAuthGuardCodeLegacy(
  accountId: string,
  steamPassword: string,
): Promise<SteamAuthGuardCode> {
  return apiRequest<SteamAuthGuardCode>('/api/v1/guard-code', {
    method: 'POST',
    body: JSON.stringify({ account_id: accountId, password: steamPassword }),
  });
}

export function accountOwnsAppId(account: SteamAuthApiAccount, appId: number): boolean {
  return (account.games ?? []).some((g) => Number(g.app_id) === appId);
}

export async function findSteamAuthAccountsForAppId(appId: number): Promise<SteamAuthApiAccount[]> {
  const accounts = await listSteamAuthAccounts();
  return accounts.filter((a) => accountUsableForAuth(a) && accountOwnsAppId(a, appId));
}

export async function checkSteamAuthHealth(): Promise<{ ok: boolean; accountCount: number; uptime?: number; error?: string }> {
  try {
    const health = await publicRequest<SteamAuthHealth>('/health');
    if (health.status !== 'ok') {
      return { ok: false, accountCount: 0, error: `Unexpected health status: ${health.status}` };
    }

    if (!apiKey()) {
      return { ok: true, accountCount: 0, uptime: health.uptime };
    }

    const accounts = await listSteamAuthAccounts();
    return { ok: true, accountCount: accounts.length, uptime: health.uptime };
  } catch (e) {
    return { ok: false, accountCount: 0, error: (e as Error).message };
  }
}
