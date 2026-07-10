/**
 * steamAuthAccounts.ts — GameGen Auth Service account pool for autogen.
 *
 * Linked accounts are tried first for autogen, then BYO owned accounts,
 * then steampass. Guard codes come from steamauth.gamegen.lol; shared_secret
 * never leaves the auth service.
 */

import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { utcDateKey } from './steampassPool';
import {
  fetchSteamAuthGuardCode,
  getSteamAuthAccount,
  isSteamAuthConfigured,
  type SteamAuthApiAccount,
} from './steamAuthClient';

export interface SteamAuthLinkedAccount {
  id: number;
  appId: number;
  accountId: string;
  steamLogin: string;
  steamPassword: string;
  refreshToken: string;
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
        steamPassword: acct.steamPassword,
        refreshToken: (acct.refreshToken || '').trim(),
      });
    }
  }
  return available;
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

export interface SteamAuthGuardResult {
  code: string;
  steamLogin: string;
}

/** Fetch a fresh TOTP code from the auth service for a linked account. */
export async function resolveSteamAuthGuard(
  linked: SteamAuthLinkedAccount,
): Promise<SteamAuthGuardResult> {
  const guard = await fetchSteamAuthGuardCode(linked.accountId, linked.steamPassword);
  const login = (guard.steam_username || linked.steamLogin || '').trim();
  if (!guard.code) {
    throw new Error('SteamAuth guard-code response missing code');
  }
  return { code: guard.code, steamLogin: login };
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
    if (apiAccount.guard_revoked) continue;
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
  steamPassword: string;
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
      steamPassword: input.steamPassword,
      label: input.label ?? null,
      active: true,
    },
    create: {
      guildId: input.guildId,
      appId: input.appId,
      accountId: input.accountId,
      steamLogin: input.steamLogin,
      steamPassword: input.steamPassword,
      label: input.label ?? null,
    },
  });
}

export async function resolveApiAccountLogin(accountId: string): Promise<string> {
  const api = await getSteamAuthAccount(accountId);
  return (api.steam_username || '').trim();
}
