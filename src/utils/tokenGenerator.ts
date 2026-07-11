/**
 * tokenGenerator.ts — Automated Denuvo token generation
 *
 * Uses headless_token.py which:
 * 1. (Optional) Uses BYO owned Steam accounts or GameGen Auth Service guard codes
 * 2. Fetches Steam credentials from steampass.gg API (fallback)
 * 3. Gets Steam Guard code from steampass.gg or steamauth.gamegen.lol
 * 4. Connects to Steam CM servers headlessly (no Steam client needed)
 * 5. Generates encrypted app ticket
 * 6. Packages everything into a zip
 *
 * Falls back to the legacy generate_token.py if no steampass UUID is configured.
 */

import { execFile } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { resolveServerConfig } from './tenant';
import { isSteampassBlocked, tripSteampassBreaker, resetSteampassBreaker } from './steampassCircuit';
import { acquireSteampassSlot } from './steampassRateLimiter';
import { isSteampassBudgetExhausted, assertSteampassBudget, recordSteampassApiCall, steampassDailyBudgetRemaining, getSteampassLedgerJson, steampassCooldownsJson } from './steampassLedger';
import { getCachedGuardCode, setCachedGuardCode } from './steampassGuardCache';

// Resolve Python — env override, venv, or system python3.
function resolvePython(): string {
  if (process.env.PYTHON_PATH) return process.env.PYTHON_PATH;
  const venvPython = '/app/.venv/bin/python';
  if (fs.existsSync(venvPython)) return venvPython;
  return 'python3';
}
const PYTHON_EXE = resolvePython();

// Where Railpack installed Python deps via `pip install --target=...`.
// Adding to PYTHONPATH lets the system python3 import those packages.
const PYTHON_DEPS_DIR = '/app/python_deps';
const HAS_DEPS_DIR = fs.existsSync(PYTHON_DEPS_DIR);

console.log(`[TokenGen] Using Python: ${PYTHON_EXE}${HAS_DEPS_DIR ? ` (deps: ${PYTHON_DEPS_DIR})` : ''}`);

const HEADLESS_SCRIPT = path.join(__dirname, '..', '..', 'headless_token.py');
const LEGACY_SCRIPT = path.join(__dirname, '..', '..', 'generate_token.py');

function buildPythonEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  if (HAS_DEPS_DIR) {
    env.PYTHONPATH = env.PYTHONPATH
      ? `${PYTHON_DEPS_DIR}:${env.PYTHONPATH}`
      : PYTHON_DEPS_DIR;
  }
  return env;
}

export interface TokenGenResult {
  zipPath: string | null;
  logs: string;
  /** 48-hex secret embedded inside the zip's payload-manifest.json as
   * `_sig`. The installer POSTs it to /installer-validate/<key> on first
   * run; bot marks it consumed. Pass to uploadFile() so the same key is
   * stored in TokenDownload, matching the manifest. */
  installerKey: string;
  /** HMAC binding fields — Python computes them inside the zip generator
   * since it's the side that has the ticket bytes. Node persists them
   * into TokenDownload so /installer-validate can verify the installer's
   * request actually came from THIS specific zip. */
  ticketHash?: string;
  expectedHmac?: string;
  appIdBound?: number;
}

/**
 * Generate a Denuvo token zip for the given AppID.
 * Returns the absolute path to the generated zip file, or null on failure.
 *
 * `guildId` selects WHICH steampass account to use. The owner/home server
 * (or a missing guildId) uses the global STEAMPASS_LOGIN/PASSWORD env;
 * a buyer server uses its own account from its TenantServer row. The
 * per-game steampass UUID is global, so only the account differs.
 *
 * `accountOverride` (owner server only): index.ts picks a pool account
 * with daily quota left for this game and passes it here; it wins over
 * the global env account.
 */
export async function generateToken(appId: number, gameName: string, guildId?: string, accountOverride?: { login: string; password: string }): Promise<TokenGenResult> {
  if (CONFIG.STEAMPASS_DISABLED) {
    return {
      zipPath: null,
      logs: 'Steampass is disabled (STEAMPASS_DISABLED). Use SteamAuth (/steamauth) or BYO accounts (/steamaccount).',
      installerKey: '',
    };
  }

  // Look up steampass UUID + generation mode from the database
  const game = await prisma.game.findFirst({ where: { appId } });
  const steampassUuid = game?.steampassUuid;
  const generationMode = (game as any)?.generationMode || 'gbe';

  if (steampassUuid) {
    return generateHeadless(appId, gameName, steampassUuid, generationMode, guildId, accountOverride);
  } else {
    console.log(`[TokenGen] No steampass UUID for AppID ${appId}, falling back to legacy generator`);
    return generateLegacy(appId, gameName);
  }
}

export interface RetryResult extends TokenGenResult {
  poolAccountId: number | null;
  exhausted: boolean;
}

/**
 * Detect steampass throttle/ban signals in a failed gen's logs. HTTP 429
 * (too many requests) and 403 (IP ban) are per-IP / global — so once we
 * see one, marching through the remaining pool accounts from the same
 * server IP only deepens the block. Matches ACTUAL HTTP responses from
 * steampass, NOT the pre-call "rate-limited!" warning line.
 */
function steampassIsThrottling(logs: string): boolean {
  if (!logs) return false;
  return /\/auth\/login returned HTTP (?:429|403)\b/i.test(logs)
    || /Steampass (?:credentials|guard-code) API (?:429|403)\b/i.test(logs);
}

async function steampassDisabledFailureMessage(
  appId: number,
  gameName: string,
  guildKey: string,
  lastSteamAuthError = '',
): Promise<string> {
  const { hasLinkedSteamAuthAccounts, steamAuthEnabled } = await import('./steamAuthAccounts');

  const linkedAuth = await hasLinkedSteamAuthAccounts(appId, guildKey);
  if (linkedAuth) {
    const detail = lastSteamAuthError
      ? `\n\nLast error: ${lastSteamAuthError}`
      : '';
    return (
      `Linked SteamAuth account(s) failed for **${gameName}** (AppID \`${appId}\`). ` +
      'Check `/steamauth list` (failure counts), `/steamauth status`, and fix broken accounts on the SteamAuth dashboard ' +
      '(missing password, guard revoked, or no maFile).' +
      detail
    );
  }

  let ownedCount = 0;
  try {
    ownedCount = await (prisma as any).ownedSteamAccount.count({
      where: { guildId: guildKey, appId, active: true },
    });
  } catch {
    ownedCount = 0;
  }
  if (ownedCount > 0) {
    return (
      `Steampass is disabled and BYO account(s) failed for **${gameName}** (AppID \`${appId}\`). ` +
      'Check `/steamaccount list` — credentials, guard secret, or daily quota may be the issue.'
    );
  }

  if (!steamAuthEnabled()) {
    return (
      'Steampass is disabled and `STEAMAUTH_API_KEY` is not set. ' +
      'Create a key at https://steamauth.gamegen.lol/dashboard, add it to the bot env, redeploy, then run `/steamauth sync` in the owner server.'
    );
  }

  return (
    `Steampass is disabled and no SteamAuth accounts are linked for **${gameName}** (AppID \`${appId}\`). ` +
    'In the owner server: `/steamauth discover` → `/steamauth sync` (or `/steamauth link account_id:<uuid> appid:<id>`). ' +
    'Alternatively register BYO Steam accounts with `/steamaccount add`.'
  );
}

export async function generateTokenWithRetry(
  appId: number,
  gameName: string,
  guildId?: string,
): Promise<RetryResult> {
  const ownedGuildKey = (!guildId || guildId === CONFIG.OWNER_GUILD_ID) ? '' : guildId;
  let lastSteamAuthError = '';

  // ── Priority 1: GameGen Auth Service (steamauth.gamegen.lol) ──
  // Credentials/guard codes fetched via API key only (GET /accounts/:id/credentials
  // or GET /accounts/:id/guard-code). No Steam password stored on the bot.
  try {
    const {
      getAvailableSteamAuthAccounts,
      hasLinkedSteamAuthAccounts,
      recordSteamAuthUsage,
      saveSteamAuthRefreshToken,
      recordSteamAuthFailure,
      resolveSteamAuthLoginMaterial,
      steamAuthEnabled,
    } = await import('./steamAuthAccounts');

    const steamAuthLinked = await hasLinkedSteamAuthAccounts(appId, ownedGuildKey);

    if (steamAuthLinked && !steamAuthEnabled()) {
      return {
        zipPath: null,
        logs: 'SteamAuth account(s) are linked for this game but STEAMAUTH_API_KEY is not set in env.',
        installerKey: '',
        poolAccountId: null,
        exhausted: false,
      };
    }

    if (steamAuthEnabled()) {
      const authAccts = await getAvailableSteamAuthAccounts(appId, ownedGuildKey);
      if (authAccts.length > 0) {
        const g = await prisma.game.findFirst({ where: { appId } });
        const uuid = g?.steampassUuid || String(appId);
        const mode = (g as any)?.generationMode || 'gbe';
        for (const authAcct of authAccts) {
          console.log(`[TokenGen:SteamAuth] Trying auth-service account #${authAcct.id} (${authAcct.steamLogin}) for AppID ${appId}`);

          const runSteamAuthGen = async (
            steamLogin: string,
            steamPassword: string,
            guardCode: string,
            refreshToken: string,
          ) => generateHeadlessSteamAuth(appId, gameName, uuid, mode, {
            steamLogin,
            steamPassword,
            guardCode,
            refreshToken,
          });

          let steamLogin = authAcct.steamLogin;
          let steamPassword = '';
          let guardCode = '';
          let refreshToken = authAcct.refreshToken;

          // Cached refresh_token → zero credential API calls (Steam CM only).
          if (refreshToken) {
            const result = await runSteamAuthGen(steamLogin, '', '', refreshToken);
            if (result.zipPath) {
              await recordSteamAuthUsage(authAcct.id);
              if (result.refreshToken) await saveSteamAuthRefreshToken(authAcct.id, result.refreshToken, result.steamId);
              console.log(`[TokenGen:SteamAuth] Success via refresh_token for #${authAcct.id}`);
              return { ...result, poolAccountId: null, exhausted: false };
            }
            console.warn(`[TokenGen:SteamAuth] refresh_token failed for #${authAcct.id} — falling back to GET /credentials`);
            refreshToken = '';
          }

          try {
            const material = await resolveSteamAuthLoginMaterial(authAcct);
            steamLogin = material.steamLogin;
            steamPassword = material.steamPassword;
            guardCode = material.guardCode;
          } catch (e) {
            lastSteamAuthError = (e as Error).message;
            console.warn(`[TokenGen:SteamAuth] Credentials fetch failed for #${authAcct.id}:`, lastSteamAuthError);
            await recordSteamAuthFailure(authAcct.id);
            continue;
          }

          const result = await runSteamAuthGen(steamLogin, steamPassword, guardCode, refreshToken);
          if (result.zipPath) {
            await recordSteamAuthUsage(authAcct.id);
            if (result.refreshToken) await saveSteamAuthRefreshToken(authAcct.id, result.refreshToken, result.steamId);
            console.log(`[TokenGen:SteamAuth] Success with auth-service account #${authAcct.id} — no steampass used`);
            return { ...result, poolAccountId: null, exhausted: false };
          }
          lastSteamAuthError = (result.logs || 'headless generator returned no zip').slice(-400);
          await recordSteamAuthFailure(authAcct.id);
          console.warn(`[TokenGen:SteamAuth] Account #${authAcct.id} failed — trying next / falling back`);
        }
      } else if (steamAuthLinked) {
        console.warn(`[TokenGen:SteamAuth] All linked accounts exhausted for AppID ${appId}`);
        return {
          zipPath: null,
          logs: 'All linked SteamAuth accounts have used their daily quota for this game.',
          installerKey: '',
          poolAccountId: null,
          exhausted: true,
        };
      }
    }
  } catch (e) {
    console.warn('[TokenGen:SteamAuth] auth-service path errored, falling back:', (e as Error).message);
  }

  // ── Priority 2: owner-provided (BYO) Steam accounts ──
  // If a Steam account the owner OWNS is registered for this game and still
  // has daily quota, use it directly (zero steampass). Only when they're
  // all exhausted or failing do we fall through to the steampass pool.
  try {
    const { getAvailableOwnedAccounts, recordOwnedUsage, saveOwnedRefreshToken, recordOwnedFailure } = await import('./ownedAccounts');
    const ownedAccts = await getAvailableOwnedAccounts(appId, ownedGuildKey);
    if (ownedAccts.length > 0) {
      const g = await prisma.game.findFirst({ where: { appId } });
      const uuid = g?.steampassUuid || String(appId);
      const mode = (g as any)?.generationMode || 'gbe';
      for (const owned of ownedAccts) {
        console.log(`[TokenGen:Owned] Trying owned Steam account #${owned.id} (${owned.steamLogin}) for AppID ${appId}`);
        const result = await generateHeadlessOwned(appId, gameName, uuid, mode, owned);
        if (result.zipPath) {
          await recordOwnedUsage(owned.id);
          if (result.refreshToken) await saveOwnedRefreshToken(owned.id, result.refreshToken, result.steamId);
          console.log(`[TokenGen:Owned] Success with owned account #${owned.id} — no steampass used`);
          return { ...result, poolAccountId: null, exhausted: false };
        }
        await recordOwnedFailure(owned.id);
        console.warn(`[TokenGen:Owned] Owned account #${owned.id} failed — trying next / falling back to steampass`);
      }
    }
  } catch (e) {
    console.warn('[TokenGen:Owned] owned-account path errored, falling back to steampass:', (e as Error).message);
  }

  if (CONFIG.STEAMPASS_DISABLED) {
    console.log('[TokenGen] Steampass disabled — skipping pool / tenant login paths');
    return {
      zipPath: null,
      logs: await steampassDisabledFailureMessage(appId, gameName, ownedGuildKey, lastSteamAuthError),
      installerKey: '',
      poolAccountId: null,
      exhausted: false,
    };
  }

  const { getAllAvailableOwnerAccounts, recordOwnerUsage } = await import('./steampassPool');

  const isOwner = !guildId || guildId === CONFIG.OWNER_GUILD_ID;

  if (!isOwner) {
    const result = await generateToken(appId, gameName, guildId);
    return { ...result, poolAccountId: null, exhausted: false };
  }

  const { accounts, exhausted } = await getAllAvailableOwnerAccounts(appId);
  if (exhausted) {
    return { zipPath: null, logs: 'All pool accounts exhausted for today.', installerKey: '', poolAccountId: null, exhausted: true };
  }

  const candidates: { id: number | null; login: string; password: string }[] = [
    ...accounts.map(a => ({ id: a.id as number | null, login: a.login, password: a.password })),
  ];

  if (candidates.length === 0) {
    const result = await generateToken(appId, gameName, guildId);
    return { ...result, poolAccountId: null, exhausted: false };
  }

  // Cap how many accounts one gen rotates through. Use every account that
  // still has daily quota — each account has its own 5/day Denuvo slot.
  const maxAttempts = candidates.length;

  let lastResult: TokenGenResult | null = null;
  for (let i = 0; i < maxAttempts; i++) {
    const cand = candidates[i];
    const label = cand.id ? `pool #${cand.id}` : 'env-var';
    console.log(`[TokenGen:Retry] Attempt ${i + 1}/${maxAttempts} (of ${candidates.length} available) using account ${label} (${cand.login})`);

    const override = { login: cand.login, password: cand.password };
    const result = await generateToken(appId, gameName, guildId, override);
    lastResult = result;

    if (result.zipPath) {
      console.log(`[TokenGen:Retry] Success on attempt ${i + 1} with account ${label}`);
      if (cand.id) await recordOwnerUsage(cand.id, appId);
      return { ...result, poolAccountId: cand.id, exhausted: false };
    }

    console.warn(`[TokenGen:Retry] Account ${label} failed, ${maxAttempts - i - 1} attempt(s) left (cap ${maxAttempts})`);

    // ── Block-avoidance: bail out early on a steampass throttle/ban ──
    // If steampass answered 429/403, every remaining account would hit the
    // SAME rate-limited IP — retrying just digs the hole deeper (and risks
    // a longer ban). Stop now and let the caller route to manual delivery.
    if (steampassIsThrottling(result.logs)) {
      console.warn(`[TokenGen:Retry] Steampass is throttling/blocking (HTTP 429/403) — aborting the remaining ${maxAttempts - i - 1} account attempt(s) so we don't deepen the block.`);
      break;
    }
  }

  console.error(`[TokenGen:Retry] ${maxAttempts} account attempt(s) failed for AppID ${appId} (of ${candidates.length} available)`);
  return { ...(lastResult ?? { zipPath: null, logs: 'All accounts failed.', installerKey: '' }), poolAccountId: null, exhausted: false };
}

/**
 * Generate a TEST token (fake credentials, no Steam authentication).
 * Used by the /test slash command so staff can verify a game's template
 * ships correctly without consuming a real steampass account.
 *
 * The output zip is labeled "TEST [Game Name].zip" and contains a
 * placeholder ticket. The structure (DLLs, configs, achievements, etc.)
 * is identical to a real token zip — only the ticket value is fake.
 */
export async function generateTestToken(appId: number, gameName: string, guildId?: string): Promise<TokenGenResult> {
  // Use the same generationMode as a real run so the test zip layout
  // matches what users would get.
  const game = await prisma.game.findFirst({ where: { appId } });
  const generationMode = (game as any)?.generationMode || 'gbe';
  return generateHeadless(appId, gameName, 'FAKE', generationMode, guildId);
}

/**
 * Headless token generation via steampass.gg + ValvePython steam library.
 * No Steam client needed — connects directly to Steam CM servers.
 *
 * generationMode controls the output layout:
 *   - "gbe" (default): flat GBE Normal — steam_api64.dll + steamclient64.dll + steam_settings/
 *   - "coldloader": V2 DLL hijack with coldloader.dll + proxy DLLs
 *   - "coldclientloader": V1 launcher with START_<game>.exe
 */
function generateHeadless(appId: number, gameName: string, steampassUuid: string, generationMode: string = 'gbe', guildId?: string, accountOverride?: { login: string; password: string }): Promise<TokenGenResult> {
  // Pre-generate the per-zip installer key NOW (before spawning Python)
  // so Python can embed it inside payload-manifest.json as `_sig`. The
  // SAME key gets handed back to the caller and persisted in
  // TokenDownload via createDownloadLink(installerKey=...) — that's how
  // the bot's /installer-validate endpoint knows which key is valid.
  const installerKey = crypto.randomBytes(24).toString('hex'); // 48 hex chars

  // Each cached Steam session is scoped to (guildId, steampassUuid).
  // Empty string = the owner/home server (global env account). A buyer
  // server passes its guildId so its cached session never collides with
  // another server that shares the same global UUID.
  const sessionGuildKey = guildId && guildId !== CONFIG.OWNER_GUILD_ID ? guildId : '';

  return new Promise(async (resolve) => {
    // Resolve WHICH steampass account this server uses. Home/owner server
    // → global STEAMPASS_LOGIN/PASSWORD env. Buyer server → its own
    // account from the TenantServer row. UUIDs are global so only the
    // account differs.
    let spLogin = process.env.STEAMPASS_LOGIN || '';
    let spPassword = process.env.STEAMPASS_PASSWORD || '';
    const isTenant = sessionGuildKey !== '';
    // Owner-pool override: index.ts already picked the pool account that
    // still has daily quota left for this game and passes it here. It
    // wins over the global env account on the owner/home server.
    if (accountOverride && accountOverride.login) {
      spLogin = accountOverride.login;
      spPassword = accountOverride.password;
      console.log('[TokenGen] Using owner-pool account override (login set)');
    } else if (isTenant) {
      try {
        const sc = await resolveServerConfig(sessionGuildKey);
        spLogin = sc.steampassLogin;
        spPassword = sc.steampassPassword;
        console.log(`[TokenGen] Using tenant steampass account for guild ${sessionGuildKey} (login=${spLogin ? 'set' : 'MISSING'})`);
      } catch (e) {
        console.warn(`[TokenGen] Tenant config lookup failed for ${sessionGuildKey}, falling back to global account:`, (e as Error).message);
      }
    }

    // Load the cached steampass bearer so Python can skip POST /auth/login
    // (the endpoint steampass rate-limits / IP-bans). The bearer is tied to
    // a specific steampass ACCOUNT, so we resolve it by spLogin — NOT by
    // "is there an override". That's the key fix: every owner gen (pool AND
    // env) routes through the override path, so the old "skip if override"
    // check meant the bearer was NEVER used and /auth/login ran every time.
    //   - pool account  → SteampassAccount.token (keyed by unique login)
    //   - global env    → Metadata "steampass_token"
    //   - tenant        → not cached here (still gets the refresh_token cache)
    // Python auto-refreshes a stale bearer, and we persist the fresh one
    // back on success below — so this self-heals without manual /setsteampass.
    let cachedToken = '';
    if (spLogin) {
      try {
        const acct = await (prisma as any).steampassAccount.findUnique({ where: { login: spLogin } });
        if (acct) {
          cachedToken = (acct.token || '').trim();
        } else if (!isTenant) {
          const row = await prisma.metadata.findUnique({ where: { key: 'steampass_token' } });
          cachedToken = (row?.value || '').trim();
        }
      } catch {
        // DB issue is non-fatal — proceed without cached token (Python
        // falls back to /auth/login).
      }
    }

    // ── Look up cached Steam session for this (guild, account, UUID) ──
    // Eliminates 1 or 2 steampass calls per gen if found. Skipped only for
    // FAKE (test) UUIDs since those don't talk to real Steam.
    //
    // The cache key includes spLogin (the steampass account actually being
    // used — env, tenant, or the owner-pool override). That's what makes
    // this safe for the owner pool: each pool account gets its OWN cached
    // session per game, so account A's refresh_token is never reused for
    // account B. Before this key change the pool bypassed the cache
    // entirely and hit steampass on every gen (rate-limit / block risk).
    // Circuit breaker: if steampass recently throttled/banned us, disable all
    // steampass calls for the cooldown window. Python then only runs the free
    // cached refresh_token path — warm games still succeed, cold games fail
    // cleanly instead of us hammering a blocked endpoint. FAKE (test) gens
    // never touch steampass, so they're never gated.
    const steampassDisabled = steampassUuid !== 'FAKE'
      ? (CONFIG.STEAMPASS_DISABLED || await isSteampassBlocked())
      : false;
    if (steampassDisabled) {
      const reason = CONFIG.STEAMPASS_DISABLED
        ? 'globally disabled'
        : 'circuit breaker OPEN';
      console.warn(`[TokenGen] Steampass ${reason} — gen for UUID ${String(steampassUuid).slice(0, 8)}… will use cached refresh_token only (no steampass calls).`);
    }

    let cachedSteamLogin = '';
    let cachedSteamPassword = '';
    let cachedRefreshToken = '';
    let cachedGuarded = true;
    if (steampassUuid && steampassUuid !== 'FAKE' && spLogin) {
      try {
        const session = await (prisma as any).steamSession.findUnique({
          where: { guildId_steampassLogin_steampassUuid: { guildId: sessionGuildKey, steampassLogin: spLogin, steampassUuid } },
        });
        if (session) {
          cachedSteamLogin = (session.steamLogin || '').trim();
          cachedSteamPassword = (session.steamPassword || '').trim();
          cachedRefreshToken = (session.refreshToken || '').trim();
          cachedGuarded = session.guarded !== false;
          console.log(
            `[TokenGen] Cached SteamSession for guild ${sessionGuildKey || 'HOME'} UUID ${steampassUuid.slice(0, 8)}…: ` +
            `login=${cachedSteamLogin ? 'yes' : 'no'}, ` +
            `refresh_token=${cachedRefreshToken ? 'yes' : 'no'}, ` +
            `last=${session.lastLoginAt?.toISOString?.() || 'never'}, ` +
            `source=${session.lastLoginSource || '-'}`
          );
        } else {
          console.log(`[TokenGen] No SteamSession cache for guild ${sessionGuildKey || 'HOME'} UUID ${steampassUuid.slice(0, 8)}… (cold start)`);
        }
      } catch (e) {
        // SteamSession lookup is best-effort. If the table doesn't exist
        // yet (migration window) or any other error happens, fall back
        // to the original "always hit steampass" behavior silently.
        console.warn('[TokenGen] SteamSession lookup failed (proceeding without cache):', e);
      }
    }

    // ── Account-wide refresh_token sharing (steamLogin → refresh_token) ──
    // A Steam refresh_token is per Steam ACCOUNT, not per game — so a token we
    // captured generating game A works for game B if steampass hands out the
    // SAME Steam account for both. We pass every refresh_token this steampass
    // account has cached (across all games), keyed by Steam login. On a cold
    // gen of a new game, once Python learns its Steam login from /profile it
    // can reuse a matching token and SKIP the guard-code call (/email/code/main
    // — the endpoint steampass throttles). This is what lets "one login" cover
    // many games instead of re-authenticating per game.
    let accountSessionsJson = '{}';
    if (steampassUuid && steampassUuid !== 'FAKE' && spLogin) {
      try {
        const rows = await (prisma as any).steamSession.findMany({
          where: { guildId: sessionGuildKey, steampassLogin: spLogin, refreshToken: { not: null } },
          select: { steamLogin: true, refreshToken: true },
          orderBy: { updatedAt: 'desc' },
          take: 100,
        });
        const map: Record<string, string> = {};
        for (const r of rows) {
          const l = (r.steamLogin || '').trim();
          const t = (r.refreshToken || '').trim();
          if (l && t && !map[l]) map[l] = t; // most-recent token per Steam login
        }
        if (Object.keys(map).length) {
          accountSessionsJson = JSON.stringify(map);
          console.log(`[TokenGen] Passing ${Object.keys(map).length} cached account refresh_token(s) for reuse across games.`);
        }
      } catch (e) {
        console.warn('[TokenGen] Account-session map lookup failed (non-fatal):', (e as Error).message);
      }
    }

    // Explicitly forward PUBLIC_URL / RAILWAY_PUBLIC_DOMAIN to Python.
    // The implicit { ...process.env } spread in buildPythonEnv() should
    // already carry these over, but we hit a case where Python's
    // _public_base_url() returned None (and the bot fell back to the
    // big embedded zip) even though the Node side could see PUBLIC_URL
    // fine. Passing them explicitly removes any ambiguity around
    // Railway's env-var inheritance.
    const publicUrlEnv = process.env.PUBLIC_URL || '';
    const railwayDomainEnv = process.env.RAILWAY_PUBLIC_DOMAIN || '';
    console.log(`[TokenGen] Forwarding PUBLIC_URL='${publicUrlEnv}' RAILWAY_PUBLIC_DOMAIN='${railwayDomainEnv}' to Python`);

    // ── Steampass human-mode: budget, endpoint pacing, guard-code reuse ──
    let steampassDisabledFinal = steampassDisabled;
    let cachedGuardCode = '';
    let cachedGuardUntil = '';
    const mightCallSteampass = steampassUuid !== 'FAKE' && !cachedRefreshToken && spLogin;

    if (mightCallSteampass && !steampassDisabledFinal) {
      const guardHit = await getCachedGuardCode(spLogin, steampassUuid);
      if (guardHit) {
        cachedGuardCode = guardHit.code;
        cachedGuardUntil = guardHit.validUntil;
        console.log(`[TokenGen] Reusing cached steampass guard code (valid until ${cachedGuardUntil})`);
      }

      if (await isSteampassBudgetExhausted()) {
        steampassDisabledFinal = true;
        console.warn('[TokenGen] Daily steampass API budget exhausted — refresh_token-only mode for this gen');
      } else {
        const endpoints: ('login' | 'profile' | 'guard')[] = [];
        if (!cachedToken) endpoints.push('login');
        if (!cachedSteamLogin || !cachedSteamPassword) {
          endpoints.push('profile');
          if (!cachedGuardCode) endpoints.push('guard');
        } else if (cachedGuarded && !cachedGuardCode) {
          endpoints.push('guard');
        }
        if (endpoints.length) {
          const budgetLeft = await steampassDailyBudgetRemaining();
          console.log(`[TokenGen] Steampass budget today: ${budgetLeft} call(s) remaining`);
          const ok = await assertSteampassBudget(endpoints.length, `${gameName} (${appId})`);
          if (!ok) steampassDisabledFinal = true;
        }
      }
    }

    const steampassLedgerJson = spLogin ? await getSteampassLedgerJson(spLogin) : '{}';

    const env = buildPythonEnv({
      STEAMPASS_LOGIN: spLogin,
      STEAMPASS_PASSWORD: spPassword,
      STEAMPASS_TOKEN: cachedToken,
      INSTALLER_KEY: installerKey,
      // Server-side secret used to sign the (sig|appId|ticketHash) tuple
      // inside payload-manifest.json. Python computes the HMAC; Node
      // doesn't need to know HMAC_SECRET itself, but it has to expose
      // it to the child process. If not set, Python skips HMAC and the
      // bot operates in consumed-only mode.
      HMAC_SECRET: process.env.HMAC_SECRET || '',
      // Cached Steam session — Python tries refresh_token first, falls
      // back to cached creds, falls back to full steampass.
      CACHED_STEAM_LOGIN: cachedSteamLogin,
      CACHED_STEAM_PASSWORD: cachedSteamPassword,
      CACHED_STEAM_REFRESH_TOKEN: cachedRefreshToken,
      CACHED_STEAM_GUARDED: cachedGuarded ? 'true' : 'false',
      // When the circuit breaker is open, Python skips every steampass call
      // (/auth/login, /profile/product-credentials, /email/code/main) and
      // only attempts the cached refresh_token login.
      STEAMPASS_DISABLED: steampassDisabledFinal ? 'true' : '',
      // Reuse a guard code steampass already issued (within valid_until).
      STEAMPASS_CACHED_GUARD_CODE: cachedGuardCode,
      STEAMPASS_CACHED_GUARD_UNTIL: cachedGuardUntil,
      // Last-call timestamps + cooldown table — Python waits before each
      // steampass endpoint so calls inside one gen are spaced like a human.
      STEAMPASS_LEDGER_STATE: steampassLedgerJson,
      STEAMPASS_LEDGER_COOLDOWNS: steampassCooldownsJson(),
      // JSON { steamLogin: refresh_token } of every session this steampass
      // account has cached, so a cold gen can reuse a token from another game
      // on the same Steam account and skip the guard-code call.
      CACHED_ACCOUNT_SESSIONS: accountSessionsJson,
      // Force-include the public URL bits so headless_token.py's
      // _public_base_url() can route to build_thin_zip instead of
      // falling back to the 50+ MB embedded multi-mode zip.
      PUBLIC_URL: publicUrlEnv,
      RAILWAY_PUBLIC_DOMAIN: railwayDomainEnv,
    });

    // Pace steampass access: a gen that will actually call steampass (no
    // cached refresh_token, real UUID, breaker closed) goes through the global
    // one-at-a-time rate limiter so we never burst the site. Warm gens
    // (refresh_token cached) make zero steampass calls and run immediately.
    const willUseSteampass = steampassUuid !== 'FAKE' && !steampassDisabledFinal && !cachedRefreshToken;
    const releaseSlot = willUseSteampass ? await acquireSteampassSlot(`AppID ${appId}`) : null;
    const releaseOnce = () => { if (releaseSlot) releaseSlot(); };

    const proc = execFile(
      PYTHON_EXE,
      [HEADLESS_SCRIPT, String(appId), gameName, steampassUuid, generationMode],
      { timeout: 120_000, maxBuffer: 20 * 1024 * 1024, env },
      async (error, stdout, stderr) => {
        const logs = stdout + (stderr ? `\n${stderr}` : '');

        if (error) {
          console.error(`[TokenGen:Headless] Process error for AppID ${appId}:`, error.message);
          // Trip the circuit breaker on a steampass throttle/ban so the NEXT
          // gen doesn't immediately re-hammer the blocked endpoint. Only the
          // 429/403 signal trips it — ordinary failures (bad Denuvo, Steam CM
          // hiccup) don't, since those aren't caused by call volume.
          if (steampassUuid !== 'FAKE' && steampassIsThrottling(logs)) {
            await tripSteampassBreaker(logs.match(/HTTP (?:429|403)[^\n]*/)?.[0] || '429/403');
          }
          // Bump failure count on THIS account's SteamSession row so we
          // don't keep hammering a dead account silently. The row is keyed
          // by (guildId, steampassLogin, steampassUuid) — i.e. the exact
          // account that just failed — so incrementing is always correct,
          // including for pool accounts. We keep the row (and its cached
          // refresh_token) rather than deleting it: the token attempt costs
          // zero steampass calls, so a stale one is cheap to retry, and a
          // whole-gen failure usually means steampass itself is down, not a
          // bad token (Python already falls through all 3 tiers per run).
          if (steampassUuid && steampassUuid !== 'FAKE' && spLogin) {
            try {
              await (prisma as any).steamSession.update({
                where: { guildId_steampassLogin_steampassUuid: { guildId: sessionGuildKey, steampassLogin: spLogin, steampassUuid } },
                data: { failureCount: { increment: 1 }, lastFailureAt: new Date() },
              });
            } catch { /* row may not exist yet — fine */ }
          }
          releaseOnce();
          resolve({ zipPath: null, logs, installerKey });
          return;
        }

        // The script outputs the zip path as the last non-empty line
        const lines = stdout.trim().split('\n').filter(l => l.trim());
        const lastLine = lines[lines.length - 1]?.trim();

        if (lastLine && fs.existsSync(lastLine)) {
          console.log(`[TokenGen:Headless] Success for AppID ${appId}: ${lastLine}`);
          // Read the sidecar .meta.json Python wrote next to the zip
          // for HMAC bookkeeping + Steam session cache update. Deletes
          // it once consumed so a leaked filesystem snapshot doesn't
          // ship the secret material.
          let ticketHash: string | undefined;
          let expectedHmac: string | undefined;
          let appIdBound: number | undefined;
          let meta: any = null;
          const metaPath = lastLine + '.meta.json';
          try {
            if (fs.existsSync(metaPath)) {
              meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
              ticketHash = typeof meta.ticket_hash === 'string' ? meta.ticket_hash : undefined;
              expectedHmac = typeof meta.expected_hmac === 'string' && meta.expected_hmac
                ? meta.expected_hmac : undefined;
              const ap = parseInt(String(meta.app_id), 10);
              appIdBound = Number.isFinite(ap) ? ap : undefined;
              try { fs.unlinkSync(metaPath); } catch {}
            }
          } catch (e) {
            console.warn('[TokenGen:Headless] Failed to read sidecar meta JSON:', e);
          }

          // Persist the (possibly refreshed) Steam session back to DB so
          // the next gen on this (account, UUID) can skip steampass. The
          // row is keyed by (guildId, steampassLogin, steampassUuid), so
          // pool accounts each get their OWN cached session — no poisoning
          // across accounts — and this now runs for pool gens too (it used
          // to be skipped, which is why the pool re-hit steampass forever).
          // Still skipped only for FAKE (test) UUIDs.
          if (meta && steampassUuid && steampassUuid !== 'FAKE' && meta.steam_login && spLogin) {
            try {
              await (prisma as any).steamSession.upsert({
                where: { guildId_steampassLogin_steampassUuid: { guildId: sessionGuildKey, steampassLogin: spLogin, steampassUuid } },
                update: {
                  steamLogin: meta.steam_login,
                  steamPassword: meta.steam_password || cachedSteamPassword,
                  refreshToken: meta.refresh_token || cachedRefreshToken || null,
                  steamId: meta.steam_id || null,
                  guarded: meta.guarded !== false,
                  lastLoginAt: new Date(),
                  lastLoginSource: meta.session_source || null,
                  failureCount: 0,
                  lastFailureAt: null,
                },
                create: {
                  guildId: sessionGuildKey,
                  steampassLogin: spLogin,
                  steampassUuid,
                  steamLogin: meta.steam_login,
                  steamPassword: meta.steam_password || '',
                  refreshToken: meta.refresh_token || null,
                  steamId: meta.steam_id || null,
                  guarded: meta.guarded !== false,
                  lastLoginAt: new Date(),
                  lastLoginSource: meta.session_source || null,
                },
              });
              console.log(
                `[TokenGen] SteamSession upserted for account ${spLogin} UUID ${steampassUuid.slice(0, 8)}… ` +
                `(source=${meta.session_source}, refresh_token=${meta.refresh_token ? 'yes' : 'no'})`
              );
            } catch (e) {
              console.warn('[TokenGen] SteamSession upsert failed (non-fatal):', e);
            }
          }

          // A gen that actually reached steampass and succeeded proves the
          // endpoint is healthy again → close the breaker. Pure refresh_token
          // gens (source='refresh_token') never touched steampass, so they
          // neither trip nor reset it.
          if (meta && (meta.session_source === 'steampass' || meta.session_source === 'cached_creds')) {
            await resetSteampassBreaker();
          }

          // Persist guard-code reuse window + ledger counts from this run.
          if (meta && spLogin && steampassUuid !== 'FAKE') {
            if (meta.guard_code && meta.guard_valid_until) {
              await setCachedGuardCode(spLogin, steampassUuid, meta.guard_code, meta.guard_valid_until);
            }
            const calls: string[] = Array.isArray(meta.steampass_calls) ? meta.steampass_calls : [];
            for (const ep of calls) {
              if (ep === 'login' || ep === 'profile' || ep === 'guard') {
                await recordSteampassApiCall(spLogin, ep);
              }
            }
          }

          // Persist a freshly-captured steampass bearer so future gens on
          // this account skip /auth/login. Python only emits
          // meta.steampass_token when it did a REAL /auth/login this run
          // (not when it reused a cached bearer), so this writes at most
          // once per account per bearer lifetime — and re-writes after a
          // 401 self-heal. Saved to the pool account row (by unique login)
          // if spLogin is one, else to the global Metadata slot.
          if (meta && meta.steampass_token && spLogin) {
            try {
              const upd = await (prisma as any).steampassAccount.updateMany({
                where: { login: spLogin },
                data: { token: meta.steampass_token },
              });
              if (upd.count === 0 && !isTenant) {
                await prisma.metadata.upsert({
                  where: { key: 'steampass_token' },
                  update: { value: meta.steampass_token },
                  create: { key: 'steampass_token', value: meta.steampass_token },
                });
              }
              console.log(`[TokenGen] Cached fresh steampass bearer for account ${spLogin} (future gens skip /auth/login)`);
            } catch (e) {
              console.warn('[TokenGen] steampass bearer cache save failed (non-fatal):', e);
            }
          }

          releaseOnce();
          resolve({ zipPath: lastLine, logs, installerKey, ticketHash, expectedHmac, appIdBound });
        } else {
          console.error(`[TokenGen:Headless] No valid zip path found. Output:\n${stdout}`);
          releaseOnce();
          resolve({ zipPath: null, logs, installerKey });
        }
      }
    );
  });
}

export interface OwnedGenResult extends TokenGenResult {
  /** refresh_token captured from the owned-account login, to cache for reuse. */
  refreshToken?: string;
  steamId?: string;
}

export interface SteamAuthGenResult extends TokenGenResult {
  refreshToken?: string;
  steamId?: string;
}

/**
 * Generate a token using GameGen Auth Service — guard code is pre-fetched
 * by Node from GET /api/v1/accounts/:id/credentials (or refresh_token reuse);
 * Python logs into Steam headlessly.
 */
function generateHeadlessSteamAuth(
  appId: number,
  gameName: string,
  steampassUuid: string,
  generationMode: string,
  auth: { steamLogin: string; steamPassword: string; guardCode: string; refreshToken: string },
): Promise<SteamAuthGenResult> {
  const installerKey = crypto.randomBytes(24).toString('hex');
  const publicUrlEnv = process.env.PUBLIC_URL || '';
  const railwayDomainEnv = process.env.RAILWAY_PUBLIC_DOMAIN || '';

  return new Promise((resolve) => {
    const env = buildPythonEnv({
      STEAMAUTH_STEAM_LOGIN: auth.steamLogin,
      STEAMAUTH_STEAM_PASSWORD: auth.steamPassword,
      STEAMAUTH_GUARD_CODE: auth.guardCode,
      CACHED_STEAM_REFRESH_TOKEN: auth.refreshToken || '',
      INSTALLER_KEY: installerKey,
      HMAC_SECRET: process.env.HMAC_SECRET || '',
      PUBLIC_URL: publicUrlEnv,
      RAILWAY_PUBLIC_DOMAIN: railwayDomainEnv,
    });

    execFile(
      PYTHON_EXE,
      [HEADLESS_SCRIPT, String(appId), gameName, steampassUuid, generationMode],
      { timeout: 120_000, maxBuffer: 20 * 1024 * 1024, env },
      (error, stdout, stderr) => {
        const logs = stdout + (stderr ? `\n${stderr}` : '');
        if (error) {
          console.error(`[TokenGen:SteamAuth] Process error for AppID ${appId}:`, error.message);
          resolve({ zipPath: null, logs, installerKey });
          return;
        }
        const lines = stdout.trim().split('\n').filter(l => l.trim());
        const lastLine = lines[lines.length - 1]?.trim();
        if (lastLine && fs.existsSync(lastLine)) {
          let ticketHash: string | undefined;
          let expectedHmac: string | undefined;
          let appIdBound: number | undefined;
          let refreshToken: string | undefined;
          let steamId: string | undefined;
          const metaPath = lastLine + '.meta.json';
          try {
            if (fs.existsSync(metaPath)) {
              const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
              ticketHash = typeof meta.ticket_hash === 'string' ? meta.ticket_hash : undefined;
              expectedHmac = typeof meta.expected_hmac === 'string' && meta.expected_hmac ? meta.expected_hmac : undefined;
              const ap = parseInt(String(meta.app_id), 10);
              appIdBound = Number.isFinite(ap) ? ap : undefined;
              refreshToken = typeof meta.refresh_token === 'string' && meta.refresh_token ? meta.refresh_token : undefined;
              steamId = typeof meta.steam_id === 'string' && meta.steam_id ? meta.steam_id : undefined;
              try { fs.unlinkSync(metaPath); } catch {}
            }
          } catch (e) {
            console.warn('[TokenGen:SteamAuth] Failed to read sidecar meta JSON:', e);
          }
          console.log(`[TokenGen:SteamAuth] Success for AppID ${appId}: ${lastLine}`);
          resolve({ zipPath: lastLine, logs, installerKey, ticketHash, expectedHmac, appIdBound, refreshToken, steamId });
        } else {
          console.error(`[TokenGen:SteamAuth] No valid zip path found. Output:\n${stdout}`);
          resolve({ zipPath: null, logs, installerKey });
        }
      }
    );
  });
}

/**
 * Generate a token using an owner-provided (BYO) Steam account — a direct
 * Steam login, zero steampass. Passes the account's credentials to Python
 * via OWNED_STEAM_* env vars; Python logs in (refresh_token first if cached,
 * else creds + optional TOTP, or no Guard) and gens the ticket. Returns the
 * same shape as generateHeadless plus the fresh refresh_token to cache.
 */
function generateHeadlessOwned(
  appId: number,
  gameName: string,
  steampassUuid: string,
  generationMode: string,
  owned: { steamLogin: string; steamPassword: string; sharedSecret: string; refreshToken: string },
): Promise<OwnedGenResult> {
  const installerKey = crypto.randomBytes(24).toString('hex');
  const publicUrlEnv = process.env.PUBLIC_URL || '';
  const railwayDomainEnv = process.env.RAILWAY_PUBLIC_DOMAIN || '';

  return new Promise((resolve) => {
    const env = buildPythonEnv({
      // Direct Steam creds — Python's owned-account branch skips steampass.
      OWNED_STEAM_LOGIN: owned.steamLogin,
      OWNED_STEAM_PASSWORD: owned.steamPassword,
      OWNED_STEAM_SHARED_SECRET: owned.sharedSecret || '',
      CACHED_STEAM_REFRESH_TOKEN: owned.refreshToken || '',
      INSTALLER_KEY: installerKey,
      HMAC_SECRET: process.env.HMAC_SECRET || '',
      PUBLIC_URL: publicUrlEnv,
      RAILWAY_PUBLIC_DOMAIN: railwayDomainEnv,
    });

    execFile(
      PYTHON_EXE,
      [HEADLESS_SCRIPT, String(appId), gameName, steampassUuid, generationMode],
      { timeout: 120_000, maxBuffer: 20 * 1024 * 1024, env },
      (error, stdout, stderr) => {
        const logs = stdout + (stderr ? `\n${stderr}` : '');
        if (error) {
          console.error(`[TokenGen:Owned] Process error for AppID ${appId}:`, error.message);
          resolve({ zipPath: null, logs, installerKey });
          return;
        }
        const lines = stdout.trim().split('\n').filter(l => l.trim());
        const lastLine = lines[lines.length - 1]?.trim();
        if (lastLine && fs.existsSync(lastLine)) {
          let ticketHash: string | undefined;
          let expectedHmac: string | undefined;
          let appIdBound: number | undefined;
          let refreshToken: string | undefined;
          let steamId: string | undefined;
          const metaPath = lastLine + '.meta.json';
          try {
            if (fs.existsSync(metaPath)) {
              const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
              ticketHash = typeof meta.ticket_hash === 'string' ? meta.ticket_hash : undefined;
              expectedHmac = typeof meta.expected_hmac === 'string' && meta.expected_hmac ? meta.expected_hmac : undefined;
              const ap = parseInt(String(meta.app_id), 10);
              appIdBound = Number.isFinite(ap) ? ap : undefined;
              refreshToken = typeof meta.refresh_token === 'string' && meta.refresh_token ? meta.refresh_token : undefined;
              steamId = typeof meta.steam_id === 'string' && meta.steam_id ? meta.steam_id : undefined;
              try { fs.unlinkSync(metaPath); } catch {}
            }
          } catch (e) {
            console.warn('[TokenGen:Owned] Failed to read sidecar meta JSON:', e);
          }
          console.log(`[TokenGen:Owned] Success for AppID ${appId}: ${lastLine}`);
          resolve({ zipPath: lastLine, logs, installerKey, ticketHash, expectedHmac, appIdBound, refreshToken, steamId });
        } else {
          console.error(`[TokenGen:Owned] No valid zip path found. Output:\n${stdout}`);
          resolve({ zipPath: null, logs, installerKey });
        }
      }
    );
  });
}

/**
 * Legacy token generation using local Steam client + generate_token.py.
 * Requires Steam to be running and logged into an account that owns the game.
 */
function generateLegacy(appId: number, gameName: string): Promise<TokenGenResult> {
  // Legacy generator doesn't emit a payload-manifest.json so the installer
  // key never gets embedded — but we still emit one for type-compat with
  // the headless path. Legacy zips are end-of-life anyway.
  const installerKey = crypto.randomBytes(24).toString('hex');
  return new Promise((resolve) => {
    const proc = execFile(
      PYTHON_EXE,
      [LEGACY_SCRIPT, String(appId), gameName],
      { timeout: 120_000, maxBuffer: 20 * 1024 * 1024, env: buildPythonEnv() },
      (error, stdout, stderr) => {
        const logs = stdout + (stderr ? `\n${stderr}` : '');

        if (error) {
          console.error(`[TokenGen:Legacy] Process error for AppID ${appId}:`, error.message);
          resolve({ zipPath: null, logs, installerKey });
          return;
        }

        const lines = stdout.trim().split('\n').filter(l => l.trim());
        const lastLine = lines[lines.length - 1]?.trim();

        if (lastLine && fs.existsSync(lastLine)) {
          console.log(`[TokenGen:Legacy] Success for AppID ${appId}: ${lastLine}`);
          resolve({ zipPath: lastLine, logs, installerKey });
        } else {
          console.error(`[TokenGen:Legacy] No valid zip path found. Output:\n${stdout}`);
          resolve({ zipPath: null, logs, installerKey });
        }
      }
    );
  });
}