/**
 * tokenGenerator.ts — Automated Denuvo token generation
 *
 * Uses headless_token.py which:
 * 1. Fetches Steam credentials from steampass.gg API
 * 2. Gets Steam Guard code from steampass.gg
 * 3. Connects to Steam CM servers headlessly (no Steam client needed)
 * 4. Generates encrypted app ticket
 * 5. Packages everything into a zip
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
  /** True when the owner-pool account couldn't authenticate with steampass
   * and we fell back to the pre-given global env account. Callers use this
   * to avoid charging the pool account's daily quota for a gen it didn't
   * actually perform. */
  usedFallbackAccount?: boolean;
}

/**
 * Heuristic: did this run fail because the steampass ACCOUNT itself is
 * unusable (bad/invalid login, email-code required, rate-limit, IP-ban,
 * or a 4xx from the credential/guard-code endpoints)? These are the cases
 * where retrying with a DIFFERENT account (the global env one) can succeed.
 * A generic Steam-side or packaging failure would NOT match, so we don't
 * pointlessly burn a second account on it.
 */
function looksLikeSteampassAccountFailure(logs: string): boolean {
  if (!logs) return false;
  const s = logs.toLowerCase();
  return (
    s.includes('/auth/login returned http') ||
    s.includes('неверный логин') ||
    /steampass[^\n]*http\s*(401|403|422|429)/.test(s) ||
    s.includes('steampass credentials api 4') ||
    s.includes('steampass guard-code api 4')
  );
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
export async function generateToken(appId: number, gameName: string, guildId?: string, accountOverride?: { login: string; password: string; token?: string }): Promise<TokenGenResult> {
  // Look up steampass UUID + generation mode from the database
  const game = await prisma.game.findFirst({ where: { appId } });
  const steampassUuid = game?.steampassUuid;
  const generationMode = (game as any)?.generationMode || 'gbe';

  if (!steampassUuid) {
    console.log(`[TokenGen] No steampass UUID for AppID ${appId}, falling back to legacy generator`);
    return generateLegacy(appId, gameName);
  }

  const first = await generateHeadless(appId, gameName, steampassUuid, generationMode, guildId, accountOverride);

  // Owner-pool → env fallback. If the picked pool account can't authenticate
  // with steampass (422 invalid login / rate-limit / IP-ban), retry ONCE on
  // the core/home server using the pre-given global env account
  // (STEAMPASS_LOGIN/PASSWORD + its own cached bearer). Only kicks in when:
  //   • we actually used a pool override,
  //   • this is the owner/home guild (never a tenant — different account),
  //   • an env account is configured and differs from the failed pool one,
  //   • the failure looks account-related (not a generic Steam/pack error).
  const isOwnerHome = !guildId || guildId === CONFIG.OWNER_GUILD_ID;
  const envLogin = (process.env.STEAMPASS_LOGIN || '').trim();
  if (
    !first.zipPath &&
    accountOverride?.login &&
    isOwnerHome &&
    envLogin &&
    envLogin !== accountOverride.login.trim() &&
    looksLikeSteampassAccountFailure(first.logs)
  ) {
    console.warn(`[TokenGen] Pool account '${accountOverride.login}' failed steampass auth — falling back to global env account '${envLogin}'.`);
    const fallback = await generateHeadless(appId, gameName, steampassUuid, generationMode, guildId, undefined);
    fallback.logs =
      first.logs +
      `\n\n[TokenGen] Pool account '${accountOverride.login}' failed steampass auth — retried with the global env account.\n` +
      fallback.logs;
    fallback.usedFallbackAccount = true;
    return fallback;
  }

  return first;
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
function generateHeadless(appId: number, gameName: string, steampassUuid: string, generationMode: string = 'gbe', guildId?: string, accountOverride?: { login: string; password: string; token?: string }): Promise<TokenGenResult> {
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

    // Load the cached steampass bearer token so Python can skip POST
    // /auth/login entirely. Falls back gracefully if none exists — Python
    // will then attempt a fresh login and surface a clear error if it 422s.
    //
    // Each steampass account has its OWN bearer: reusing another account's
    // bearer would auth as the wrong account. So the source depends on who
    // we're authing as:
    //   • Owner-pool override → the picked account's own cached token
    //     (SteampassAccount.token, set via `/setsteampass account:<id>`).
    //   • Home/owner global account → Metadata `steampass_token`
    //     (set via `/setsteampass`).
    //   • Tenant → no cached bearer; fresh /auth/login with its own creds.
    let cachedToken = '';
    if (accountOverride && accountOverride.login) {
      cachedToken = (accountOverride.token || '').trim();
    } else if (!isTenant) {
      try {
        const row = await prisma.metadata.findUnique({ where: { key: 'steampass_token' } });
        cachedToken = (row?.value || '').trim();
      } catch {
        // Metadata table issue is non-fatal — proceed without cached token.
      }
    }

    // ── Look up cached Steam session for this (guild, UUID) ──
    // Eliminates 1 or 2 steampass calls per gen if found. Skipped for
    // FAKE (test) UUIDs since those don't talk to real Steam.
    let cachedSteamLogin = '';
    let cachedSteamPassword = '';
    let cachedRefreshToken = '';
    let cachedGuarded = true;
    if (steampassUuid && steampassUuid !== 'FAKE') {
      try {
        const session = await (prisma as any).steamSession.findUnique({
          where: { guildId_steampassUuid: { guildId: sessionGuildKey, steampassUuid } },
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
      // Force-include the public URL bits so headless_token.py's
      // _public_base_url() can route to build_thin_zip instead of
      // falling back to the 50+ MB embedded multi-mode zip.
      PUBLIC_URL: publicUrlEnv,
      RAILWAY_PUBLIC_DOMAIN: railwayDomainEnv,
    });

    const proc = execFile(
      PYTHON_EXE,
      [HEADLESS_SCRIPT, String(appId), gameName, steampassUuid, generationMode],
      { timeout: 120_000, maxBuffer: 20 * 1024 * 1024, env },
      async (error, stdout, stderr) => {
        const logs = stdout + (stderr ? `\n${stderr}` : '');

        if (error) {
          console.error(`[TokenGen:Headless] Process error for AppID ${appId}:`, error.message);
          // Bump failure count on the SteamSession row so we don't keep
          // hammering a dead account silently.
          if (steampassUuid && steampassUuid !== 'FAKE') {
            try {
              await (prisma as any).steamSession.update({
                where: { guildId_steampassUuid: { guildId: sessionGuildKey, steampassUuid } },
                data: { failureCount: { increment: 1 }, lastFailureAt: new Date() },
              });
            } catch { /* row may not exist yet — fine */ }
          }
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
          // the next gen on this UUID can skip steampass. Skipped for
          // FAKE UUIDs (test mode) since those don't represent a real
          // account.
          if (meta && steampassUuid && steampassUuid !== 'FAKE' && meta.steam_login) {
            try {
              await (prisma as any).steamSession.upsert({
                where: { guildId_steampassUuid: { guildId: sessionGuildKey, steampassUuid } },
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
                `[TokenGen] SteamSession upserted for UUID ${steampassUuid.slice(0, 8)}… ` +
                `(source=${meta.session_source}, refresh_token=${meta.refresh_token ? 'yes' : 'no'})`
              );
            } catch (e) {
              console.warn('[TokenGen] SteamSession upsert failed (non-fatal):', e);
            }
          }

          resolve({ zipPath: lastLine, logs, installerKey, ticketHash, expectedHmac, appIdBound });
        } else {
          console.error(`[TokenGen:Headless] No valid zip path found. Output:\n${stdout}`);
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