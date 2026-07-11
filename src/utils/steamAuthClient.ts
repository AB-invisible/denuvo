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

function guardUnavailableReason(data: Pick<SteamAuthGuardCode, 'has_steam_guard' | 'guard_revoked'>): string {
  if (data.guard_revoked) return 'SteamAuth account has Guard revoked on the service';
  if (!data.has_steam_guard) return 'SteamAuth account has no shared secret (has_steam_guard: false)';
  return 'SteamAuth guard-code response missing code';
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
  if (!data.code) {
    throw new Error(guardUnavailableReason(data));
  }
  return data;
}

/** Full login material in one call — username, password, and current guard code. */
export async function fetchSteamAuthCredentials(accountId: string): Promise<SteamAuthCredentials> {
  const data = await apiRequest<SteamAuthCredentials>(
    `/api/v1/accounts/${encodeURIComponent(accountId)}/credentials`,
  );
  if (!data.password || !data.steam_username) {
    throw new Error('SteamAuth credentials response missing required fields');
  }
  if (!data.code) {
    throw new Error(guardUnavailableReason(data));
  }
  return data;
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
  return accounts.filter((a) => accountCanProvideGuardCode(a) && accountOwnsAppId(a, appId));
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
