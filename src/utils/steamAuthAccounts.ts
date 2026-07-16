/**
 * steamAuthAccounts.ts — GameGen Auth Service account pool for autogen.
 *
 * Linked accounts are tried first for autogen, then BYO owned accounts,
 * then steampass. Credentials and guard codes are fetched at gen time via
 * GET /api/v1/accounts/:id/credentials (API key only — no password stored).
 */

import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { utcDateKey } from './steampassPool';
import {
  accountUsableForAuth,
  fetchSteamAuthCredentials,
  fetchSteamAuthGuardCode,
  getSteamAuthAccount,
  isSteamAuthConfigured,
  validateSteamAuthAccountForGen,
  type SteamAuthApiAccount,
} from './steamAuthClient';

export interface SteamAuthLinkedAccount {
  id: number;
  appId: number;
  accountId: string;
  steamLogin: string;
  refreshToken: string;
}

export interface SteamAuthLoginMaterial {
  steamLogin: string;
  steamPassword: string;
  guardCode: string;
}

export function steamAuthEnabled(): boolean {
  return isSteamAuthConfigured();
}

export async function getAvailableSteamAuthAccounts(
  appId: number,
  guildId: string,
): Promise<SteamAuthLinkedAccount[]> {
  if (!steamAuthEnabled()) return [];

  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const today = utcDateKey();

  let accounts: any[] = [];
  try {
    accounts = await (prisma as any).steamAuthAccount.findMany({
      where: { guildId, appId, active: true },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
  } catch (e) {
    console.warn('[steamAuthAccounts] lookup failed (treating as none):', (e as Error).message);
    return [];
  }

  const available: SteamAuthLinkedAccount[] = [];
  for (const acct of accounts) {
    let used = 0;
    try {
      const usage = await (prisma as any).steamAuthUsage.findUnique({
        where: { accountId_usageDate: { accountId: acct.id, usageDate: today } },
      });
      used = usage?.count ?? 0;
    } catch {
      used = 0;
    }
    if (used < cap) {
      available.push({
        id: acct.id,
        appId: acct.appId,
        accountId: acct.accountId,
        steamLogin: acct.steamLogin,
        refreshToken: (acct.refreshToken || '').trim(),
      });
    }
  }
  return available;
}

/** True when at least one active SteamAuth link exists for this game (ignores daily quota). */
export async function hasLinkedSteamAuthAccounts(
  appId: number,
  guildId: string = '',
): Promise<boolean> {
  try {
    const count = await (prisma as any).steamAuthAccount.count({
      where: { guildId, appId, active: true },
    });
    return count > 0;
  } catch {
    return false;
  }
}

export async function recordSteamAuthUsage(accountId: number): Promise<void> {
  const today = utcDateKey();
  try {
    await (prisma as any).steamAuthUsage.upsert({
      where: { accountId_usageDate: { accountId, usageDate: today } },
      update: { count: { increment: 1 } },
      create: { accountId, usageDate: today, count: 1 },
    });
    await (prisma as any).steamAuthAccount.update({
      where: { id: accountId },
      data: { lastUsedAt: new Date(), failureCount: 0, lastFailureAt: null },
    });
    const acct = await (prisma as any).steamAuthAccount.findUnique({
      where: { id: accountId },
      select: { appId: true },
    });
    if (acct?.appId) {
      const { syncStockForAppId } = await import('./accountCapacity');
      await syncStockForAppId(acct.appId).catch(() => {});
    }
  } catch (e) {
    console.warn('[steamAuthAccounts] recordUsage failed (non-fatal):', (e as Error).message);
  }
}

export async function saveSteamAuthRefreshToken(
  accountId: number,
  refreshToken: string,
  steamId?: string,
): Promise<void> {
  if (!refreshToken) return;
  try {
    await (prisma as any).steamAuthAccount.update({
      where: { id: accountId },
      data: { refreshToken, ...(steamId ? { steamId } : {}) },
    });
  } catch (e) {
    console.warn('[steamAuthAccounts] saveRefreshToken failed (non-fatal):', (e as Error).message);
  }
}

export async function recordSteamAuthFailure(accountId: number): Promise<void> {
  try {
    await (prisma as any).steamAuthAccount.update({
      where: { id: accountId },
      data: { failureCount: { increment: 1 }, lastFailureAt: new Date() },
    });
  } catch {
    /* non-fatal */
  }
}

/**
 * Fetch full login material from GET /credentials (recommended cold-start path).
 * Password never touches our DB — only used in-memory for the Steam CM login.
 */
export async function resolveSteamAuthLoginMaterial(
  linked: SteamAuthLinkedAccount,
): Promise<SteamAuthLoginMaterial> {
  const creds = await fetchSteamAuthCredentials(linked.accountId);
  if (!creds.code) {
    throw new Error('SteamAuth credentials response missing guard code');
  }
  return {
    steamLogin: (creds.steam_username || linked.steamLogin || '').trim(),
    steamPassword: creds.password,
    guardCode: creds.code,
  };
}

/**
 * Guard code only — used when a cached refresh_token handles the Steam login
 * but we still need the username refreshed from the service.
 */
export async function resolveSteamAuthGuardOnly(
  linked: SteamAuthLinkedAccount,
): Promise<{ steamLogin: string; guardCode: string }> {
  const guard = await fetchSteamAuthGuardCode(linked.accountId);
  const login = (guard.steam_username || linked.steamLogin || '').trim();
  return { steamLogin: login, guardCode: guard.code || '' };
}

export interface DiscoverMatch {
  apiAccount: SteamAuthApiAccount;
  appIds: number[];
  gameNames: string[];
}

/** Map API accounts to AppIDs present in our game catalog. */
export async function discoverSteamAuthMatches(): Promise<DiscoverMatch[]> {
  const { listSteamAuthAccounts } = await import('./steamAuthClient');
  const allAccounts = await listSteamAuthAccounts();

  const appIds = new Set<number>();
  for (const a of allAccounts) {
    for (const g of a.games ?? []) {
      if (g.app_id) appIds.add(Number(g.app_id));
    }
  }
  if (appIds.size === 0) return [];

  const games = await prisma.game.findMany({ where: { appId: { in: [...appIds] } } });
  const nameByAppId = new Map(games.map((g) => [g.appId!, g.name]));

  const matches: DiscoverMatch[] = [];
  for (const apiAccount of allAccounts) {
    if (!accountUsableForAuth(apiAccount)) continue;
    const ownedAppIds: number[] = [];
    const gameNames: string[] = [];
    for (const g of apiAccount.games ?? []) {
      const id = Number(g.app_id);
      if (nameByAppId.has(id)) {
        ownedAppIds.push(id);
        gameNames.push(nameByAppId.get(id)!);
      }
    }
    if (ownedAppIds.length > 0) {
      matches.push({ apiAccount, appIds: ownedAppIds, gameNames });
    }
  }
  return matches;
}

export async function upsertSteamAuthLink(input: {
  guildId: string;
  appId: number;
  accountId: string;
  steamLogin: string;
  label?: string | null;
}): Promise<any> {
  return (prisma as any).steamAuthAccount.upsert({
    where: {
      guildId_appId_accountId: {
        guildId: input.guildId,
        appId: input.appId,
        accountId: input.accountId,
      },
    },
    update: {
      steamLogin: input.steamLogin,
      label: input.label ?? null,
      active: true,
    },
    create: {
      guildId: input.guildId,
      appId: input.appId,
      accountId: input.accountId,
      steamLogin: input.steamLogin,
      steamPassword: '',
      label: input.label ?? null,
    },
  });
}

/** Auto-link every discovered API account ↔ catalog game match. */
export async function syncSteamAuthLinks(guildId: string = ''): Promise<{ linked: number; skipped: number; invalid: number }> {
  const matches = await discoverSteamAuthMatches();
  let linked = 0;
  let skipped = 0;
  let invalid = 0;
  for (const m of matches) {
    const probe = await validateSteamAuthAccountForGen(m.apiAccount.account_id);
    if (!probe.ok) {
      console.warn(
        `[steamAuthAccounts] Skipping ${m.apiAccount.steam_username} (${m.apiAccount.account_id.slice(0, 8)}…): ${probe.reason}`,
      );
      invalid++;
      continue;
    }
    for (let i = 0; i < m.appIds.length; i++) {
      const appId = m.appIds[i];
      const existing = await (prisma as any).steamAuthAccount.findUnique({
        where: {
          guildId_appId_accountId: {
            guildId,
            appId,
            accountId: m.apiAccount.account_id,
          },
        },
      }).catch(() => null);
      if (existing) {
        skipped++;
        continue;
      }
      await upsertSteamAuthLink({
        guildId,
        appId,
        accountId: m.apiAccount.account_id,
        steamLogin: m.apiAccount.steam_username,
      });
      linked++;
    }
  }
  return { linked, skipped, invalid };
}

export async function resolveApiAccountLogin(accountId: string): Promise<string> {
  const api = await getSteamAuthAccount(accountId);
  return (api.steam_username || '').trim();
}
