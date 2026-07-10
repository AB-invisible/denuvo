/**
 * steamAuthClient.ts — HTTP client for GameGen Auth Service
 * (https://steamauth.gamegen.lol). Guard codes are generated server-side;
 * the bot only needs the Steam password to verify via POST /api/v1/guard-code.
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
  main_game?: string | null;
  subsidiary_names?: string[];
  games?: SteamAuthApiGame[];
  games_count?: number;
  games_sync_status?: string;
  guard_revoked?: boolean;
}

export interface SteamAuthGuardCode {
  account_id: string;
  code: string;
  expires_in: number;
  steam_username: string;
}

function baseUrl(): string {
  return (CONFIG.STEAMAUTH_API_URL || 'https://steamauth.gamegen.lol').replace(/\/$/, '');
}

function apiKey(): string {
  return (CONFIG.STEAMAUTH_API_KEY || '').trim();
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
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const msg = typeof data?.error === 'string' ? data.error : text.slice(0, 300) || res.statusText;
    throw new Error(`SteamAuth API ${path} failed: HTTP ${res.status} — ${msg}`);
  }
  return data as T;
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

export async function fetchSteamAuthGuardCode(
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
  return accounts.filter((a) => !a.guard_revoked && accountOwnsAppId(a, appId));
}

export async function checkSteamAuthHealth(): Promise<{ ok: boolean; accountCount: number; error?: string }> {
  try {
    const accounts = await listSteamAuthAccounts();
    return { ok: true, accountCount: accounts.length };
  } catch (e) {
    return { ok: false, accountCount: 0, error: (e as Error).message };
  }
}
