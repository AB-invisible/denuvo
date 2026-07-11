/**
 * Lightweight HTTP server that serves Goldberg/coldclientloader binaries
 * to the installer.exe on demand.
 *
 * The token zip we hand the user only contains the installer + ticket +
 * a small payload-manifest.json. When the installer needs to deploy a
 * specific mode (GBE or V1), it downloads the binaries from here.
 *
 * Routes:
 *   GET /payload/health
 *     → "ok" (used by Railway healthchecks if any)
 *
 *   GET /payload/gbe/<filename>
 *     → file under _Core/                      (steam_api64.dll, steamclient64.dll, …)
 *
 *   GET /payload/v1/<filename>
 *     → file under _Core/coldclientloader/     (steamclient_loader_x64.exe, …)
 *
 * Anything else → 404. Path-traversal protection rejects ".." in filenames.
 *
 * To enable in production: Railway service Settings → Networking →
 * "Generate Domain", then either rely on the auto-injected
 * RAILWAY_PUBLIC_DOMAIN env var or set PUBLIC_URL manually.
 */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { UBISOFT_CATALOG, resolveMagicDir, locateMagicZip } from './utils/ubisoftCatalog';
import { resolveMagicFile as resolveEaMagicFile, resolveMagicDir as resolveEaMagicDir } from './utils/eaCatalog';

const CORE_DIR = path.join(__dirname, '..', '_Core');
const PANEL_ASSET_DIR = path.join(__dirname, 'public');
const PANEL_ASSETS = new Set(['gamegen.png', 'maintenance.png']);

// Lazy Prisma loader — same pattern as downloadHost.ts. Keeps a module-
// load-time failure in @prisma/client from blowing up the HTTP server's
// import chain before it can even bind a port.
async function getPrisma() {
  const mod = await import('./lib/prisma');
  return mod.default;
}

// Map URL "mode" segment → sub-directory under _Core/.
// gbe and v2 both source from _Core/ directly because the V2 (coldloader)
// payload re-uses several of the same DLLs the GBE flat layout ships
// (steam_api64.dll, steamclient64.dll, GameOverlayRenderer64.dll) plus
// the V2-specific coldloader.dll and version.dll hijack proxy. V1 uses
// the experimental Goldberg variants in _Core/coldclientloader/.
const MODE_DIRS: Record<string, string> = {
  gbe: '',
  v1: 'coldclientloader',
  v2: '',
};

// Constant-time string compare for secrets (API bearer tokens, HMACs).
// Plain `===`/`!==` short-circuits on the first differing byte, leaking
// length/prefix info via response timing. timingSafeEqual needs equal
// lengths, so we length-check first (a length mismatch is already a
// guaranteed non-match, so revealing it via timing costs nothing).
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ── Lightweight in-memory rate limiter for the /admin/* endpoints ──
// The admin routes can drive token generation (which burns steampass
// quota) and are protected only by a bearer token. If that token ever
// leaks, an unthrottled attacker could hammer generation. Cap requests
// per client IP per window. In-memory is fine — payloadServer is a
// single process; a restart just resets the counters.
const adminHits = new Map<string, number[]>();
function clientIp(req: http.IncomingMessage): string {
  const xff = (req.headers['x-forwarded-for'] || '').toString();
  // Railway/most proxies prepend the real client IP as the first hop.
  if (xff) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}
function adminRateLimited(ip: string, limit = 12, windowMs = 60_000): boolean {
  const now = Date.now();
  const recent = (adminHits.get(ip) || []).filter(t => now - t < windowMs);
  recent.push(now);
  adminHits.set(ip, recent);
  // Opportunistic cleanup so the map doesn't grow unbounded across IPs.
  if (adminHits.size > 1000) {
    for (const [k, v] of adminHits) {
      if (v.every(t => now - t >= windowMs)) adminHits.delete(k);
    }
  }
  return recent.length > limit;
}

function resolveFile(mode: string, filename: string): string | null {
  if (!(mode in MODE_DIRS)) return null;
  // Reject anything that escapes the mode dir: no slashes, no parent-dir hops.
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) return null;

  const subPath = MODE_DIRS[mode];
  const full = subPath
    ? path.join(CORE_DIR, subPath, filename)
    : path.join(CORE_DIR, filename);

  const resolved = path.resolve(full);
  const coreRoot = path.resolve(CORE_DIR);
  if (!resolved.startsWith(coreRoot + path.sep) && resolved !== coreRoot) {
    return null;
  }
  return fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : null;
}

// Resolve a per-game override file under _Core/overrides/<appid>/<filename>.
// Lets specific games ship a different emulator binary than the shared
// _Core/ default (e.g. The Bus needs a specific steamclient64.dll build).
// Same path-traversal guards as resolveFile: numeric appid, no slashes or
// ".." in the filename, and the resolved path must stay inside overrides/.
function resolveOverrideFile(appid: string, filename: string): string | null {
  if (!/^[0-9]+$/.test(appid)) return null;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) return null;

  const overridesRoot = path.resolve(path.join(CORE_DIR, 'overrides'));
  const resolved = path.resolve(path.join(overridesRoot, appid, filename));
  if (!resolved.startsWith(overridesRoot + path.sep)) return null;
  return fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : null;
}

// Resolve the magic-files zip for a Ubisoft appid inside UBISOFT_MAGIC_DIR.
// The catalog maps the appid → the exact zip filename; we also accept a
// literal "<appid>.zip" so operators can name files by appid if they prefer.
// Path stays inside magicDir (no traversal); the zip filename itself comes
// from the catalog constant, not from user input.
function resolveMagicFile(magicDir: string, appId: string): { filePath: string; downloadName: string } | null {
  if (!/^[0-9]+$/.test(appId)) return null;
  const numericAppId = Number.parseInt(appId, 10);

  const entry = UBISOFT_CATALOG.find(
    (e) => e.ubisoftAppId === numericAppId || e.ubisoftAltAppId === numericAppId,
  );

  const located = locateMagicZip(magicDir, entry?.magicFile ?? `${appId}.zip`, entry);
  if (located) {
    return { filePath: located.path, downloadName: located.filename };
  }

  const fallback = path.resolve(path.join(path.resolve(magicDir), `${appId}.zip`));
  const root = path.resolve(magicDir);
  if (
    fallback !== root &&
    fallback.startsWith(root + path.sep) &&
    fs.existsSync(fallback) &&
    fs.statSync(fallback).isFile()
  ) {
    return { filePath: fallback, downloadName: `${appId}.zip` };
  }

  return null;
}

export function startPayloadServer(): void {
  const portRaw = process.env.PORT || '3000';
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    console.warn(`[PayloadServer] Invalid PORT=${portRaw} — server NOT started`);
    return;
  }

  if (!fs.existsSync(CORE_DIR)) {
    console.warn(`[PayloadServer] _Core/ not found at ${CORE_DIR} — server NOT started`);
    return;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');

      if (url.pathname === '/payload/health' || url.pathname === '/health' || url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }

      const assetMatch = url.pathname.match(/^\/assets\/([a-z0-9._-]+)$/i);
      if (req.method === 'GET' && assetMatch) {
        const filename = assetMatch[1];
        if (!PANEL_ASSETS.has(filename)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
          return;
        }
        const filePath = path.join(PANEL_ASSET_DIR, filename);
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }

      // ── Ubisoft magic-files zip ──────────────────────────────────────
      // GET /ubisoft/magic/<ubisoftAppId>
      //   → streams the "* Magic Files.zip" for that game from
      //     UBISOFT_MAGIC_DIR. The bot links here in the two-step Ubisoft
      //     flow so users grab the Uplay/Denuvo crack files before running
      //     the game to produce a token_req. Numeric appid guard only; the
      //     bot maps game→file and the resolver picks the file by appid.
      const magicMatch = url.pathname.match(/^\/ubisoft\/magic\/([0-9]+)$/);
      if ((req.method === 'GET' || req.method === 'HEAD') && magicMatch) {
        const appId = magicMatch[1];
        const magicDir = resolveMagicDir();
        const resolved = resolveMagicFile(magicDir, appId);
        if (!resolved) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('magic files not found for this appid');
          return;
        }
        const stat = fs.statSync(resolved.filePath);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${resolved.downloadName}"`,
          'Cache-Control': 'public, max-age=3600',
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        fs.createReadStream(resolved.filePath).pipe(res);
        return;
      }

      // ── EA setup zip ───────────────────────────────────────────────
      // GET /ea/magic/<contentId>
      const eaMagicMatch = url.pathname.match(/^\/ea\/magic\/([0-9]+)$/);
      if ((req.method === 'GET' || req.method === 'HEAD') && eaMagicMatch) {
        const contentId = eaMagicMatch[1];
        const magicDir = resolveEaMagicDir();
        const resolved = resolveEaMagicFile(magicDir, contentId);
        if (!resolved) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('ea setup zip not found for this content id');
          return;
        }
        const stat = fs.statSync(resolved.filePath);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${resolved.downloadName}"`,
          'Cache-Control': 'public, max-age=3600',
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        fs.createReadStream(resolved.filePath).pipe(res);
        return;
      }

      // ── Staff API: register a key produced by an external generator ──
      // POST /admin/register-key
      //   Authorization: Bearer <STAFF_API_TOKEN>
      //   Content-Type: application/json
      //   Body: {
      //     "installerKey": "<48-hex>",
      //     "appId": 3321460,
      //     "ticketHash": "<64-hex sha256>",
      //     "gameName": "Crimson Desert",
      //     "expiresInMinutes": 30,
      //     "fileName": "Token [Crimson Desert].zip"   (optional, for audit)
      //   }
      //
      //   →  200 OK
      //      {
      //        "expectedHmac": "<the HMAC value to embed as _hmac>",
      //        "expiresAt": "ISO-8601",
      //        "ok": true
      //      }
      //
      // This is the entry point for a standalone desktop generator that
      // does its own steampass auth + zip building locally. The bot's
      // only job here is to:
      //   1. Verify the request is from staff (bearer token)
      //   2. Compute the HMAC server-side using HMAC_SECRET (so the
      //      secret never leaves Railway)
      //   3. Insert a TokenDownload row so the installer's later POST
      //      to /installer-validate/<sig> resolves and consumes it
      //
      // The external generator embeds the returned `expectedHmac` into
      // the manifest's `_hmac` field, plus its locally-generated
      // installerKey as `_sig`, plus the ticket hash as `_th`. The
      // resulting zip behaves identically to a bot-generated one when
      // an end user runs the installer — same consumed flag, same HMAC
      // binding, same 30-min lifetime.
      if (url.pathname === '/admin/register-key' && req.method === 'POST') {
        if (adminRateLimited(clientIp(req))) {
          res.writeHead(429, { 'Content-Type': 'text/plain' });
          res.end('Too many requests — slow down.');
          return;
        }
        const expectedToken = (process.env.STAFF_API_TOKEN || '').trim();
        if (!expectedToken) {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('STAFF_API_TOKEN env var is not configured on this server.');
          return;
        }
        const auth = (req.headers.authorization || '').trim();
        if (!safeEqual(auth, `Bearer ${expectedToken}`)) {
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end('Unauthorized — bad or missing Bearer token.');
          return;
        }

        // JSON body (cap at 64 KB)
        const chunks2: Buffer[] = [];
        let total2 = 0;
        let aborted2 = false;
        for await (const chunk of req) {
          chunks2.push(chunk as Buffer);
          total2 += (chunk as Buffer).length;
          if (total2 > 64 * 1024) { aborted2 = true; break; }
        }
        if (aborted2) {
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end('Request body too large.');
          return;
        }
        let regBody: any;
        try {
          regBody = JSON.parse(Buffer.concat(chunks2).toString('utf-8') || '{}');
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid JSON body.');
          return;
        }

        const installerKey = String(regBody.installerKey || '').trim();
        const ticketHash = String(regBody.ticketHash || '').trim();
        const appIdNum = Number.parseInt(String(regBody.appId || ''), 10);
        const gameName = String(regBody.gameName || '').trim();
        const ttlMinutes = Math.min(Math.max(Number.parseInt(String(regBody.expiresInMinutes || '30'), 10) || 30, 1), 720);
        const fileName = String(regBody.fileName || `Token [${gameName || 'Game'}].zip`);

        if (!/^[a-f0-9]{16,128}$/i.test(installerKey)) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('installerKey must be 16–128 hex characters.');
          return;
        }
        if (!/^[a-f0-9]{16,128}$/i.test(ticketHash)) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('ticketHash must be 16–128 hex characters.');
          return;
        }
        if (!Number.isFinite(appIdNum) || appIdNum <= 0) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('appId must be a positive integer.');
          return;
        }

        try {
          const secret = (process.env.HMAC_SECRET || '').trim();
          const expectedHmac = secret
            ? crypto.createHmac('sha256', secret).update(`${installerKey}|${appIdNum}|${ticketHash}`).digest('hex')
            : '';

          const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
          const prisma = await getPrisma();
          await prisma.tokenDownload.create({
            data: {
              // download URL token is unused for this path (no /download/<x>
              // route — staff hosts the zip themselves), but the column is
              // the PK so we generate something unique.
              token: crypto.randomBytes(24).toString('hex'),
              installerKey,
              ticketHash,
              expectedHmac: expectedHmac || null,
              appId: appIdNum,
              filePath: '',           // intentionally empty — no server-hosted file
              fileName,
              fileSize: 0,
              expiresAt,
              ticketId: null,
            },
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            expectedHmac,
            expiresAt: expiresAt.toISOString(),
            expiresInMinutes: ttlMinutes,
          }));
        } catch (e: any) {
          console.error('[Admin] /admin/register-key error', e);
          // Unique constraint on installerKey → caller already registered this sig
          if (e?.code === 'P2002') {
            res.writeHead(409, { 'Content-Type': 'text/plain' });
            res.end('installerKey already registered. Generate a new one and retry.');
            return;
          }
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error', detail: String(e).slice(0, 400) }));
        }
        return;
      }

      // ── Staff API: generate a token + return its download link ──
      // POST /admin/generate-token
      //   Authorization: Bearer <STAFF_API_TOKEN>
      //   Content-Type: application/json
      //   Body: { "appId": 3321460, "gameName": "Crimson Desert" }
      //
      // Returns 200 with { downloadUrl, expiresAt, expiresInMinutes }.
      // Lets staff drive token issuance from a separate app (CLI, GUI,
      // whatever) without going through the Discord ticket flow. Each
      // issued token still has all the normal protections — single-use
      // consumed flag, HMAC binding (if HMAC_SECRET is set), 30-min
      // link expiry, installer self-destruct on rejection.
      if (url.pathname === '/admin/generate-token' && req.method === 'POST') {
        if (adminRateLimited(clientIp(req))) {
          res.writeHead(429, { 'Content-Type': 'text/plain' });
          res.end('Too many requests — slow down.');
          return;
        }
        const expectedToken = (process.env.STAFF_API_TOKEN || '').trim();
        if (!expectedToken) {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('STAFF_API_TOKEN env var is not configured on this server.');
          return;
        }
        const auth = (req.headers.authorization || '').trim();
        if (!safeEqual(auth, `Bearer ${expectedToken}`)) {
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end('Unauthorized — bad or missing Bearer token.');
          return;
        }

        // Read JSON body (cap at 64 KB just to be defensive).
        const chunks: Buffer[] = [];
        let total = 0;
        let aborted = false;
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
          total += (chunk as Buffer).length;
          if (total > 64 * 1024) { aborted = true; break; }
        }
        if (aborted) {
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end('Request body too large.');
          return;
        }
        let body: any;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid JSON body.');
          return;
        }

        const appId = Number.parseInt(String(body.appId || ''), 10);
        const gameName = String(body.gameName || '').trim();
        if (!Number.isFinite(appId) || appId <= 0 || !gameName) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Request must include numeric appId and non-empty gameName.');
          return;
        }

        try {
          // Dynamic imports keep payloadServer.ts loadable even when the
          // generator or upload modules have init issues (same isolation
          // pattern as our Prisma loader).
          const { generateTokenWithRetry } = await import('./utils/tokenGenerator');
          const { uploadFile } = await import('./utils/fileHost');

          const result = await generateTokenWithRetry(appId, gameName);
          if (!result.zipPath) {
            console.error('[Admin] Token generation failed:', result.logs.slice(-500));
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'generation_failed',
              detail: result.logs.slice(-400),
            }));
            return;
          }

          const upload = await uploadFile(
            result.zipPath,
            '24h',
            result.installerKey,
            {
              ticketHash: result.ticketHash,
              expectedHmac: result.expectedHmac,
              appIdBound: result.appIdBound,
            },
          );

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            downloadUrl: upload.url,
            provider: upload.provider,
            expiryText: upload.expiryText,
            expiresInMinutes: 30,
            // sig is the same as the installerKey embedded in the manifest,
            // useful for staff audit trails / their app's UI.
            installerKey: result.installerKey,
          }));
        } catch (e) {
          console.error('[Admin] /admin/generate-token error', e);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error', detail: String(e).slice(0, 400) }));
        }
        return;
      }

      // ── Installer activation-key validation ──────────────
      // POST /installer-validate/<key>?th=<ticketHash>&hmac=<hmac>&app=<appId>
      //
      // The installer reads `_sig`, `_th`, `_hmac`, and `app_id` from
      // payload-manifest.json and sends them all on first run. Server:
      //   1. Looks up by _sig.
      //   2. Rejects if missing/expired/consumed.
      //   3. If HMAC binding fields are stored, verifies:
      //        - provided._th == stored.ticketHash (manifest unmodified)
      //        - provided._hmac == stored.expectedHmac (basic match)
      //        - recomputed hmac(SECRET, sig|appId|ticketHash) == stored.expectedHmac
      //          (defends against DB-row tampering by attacker with DB access)
      //   4. On success: flip consumed=true → 200.
      const vm = url.pathname.match(/^\/installer-validate\/([a-f0-9]{8,128})$/);
      if (vm && (req.method === 'POST' || req.method === 'GET')) {
        const key = vm[1];
        const params = url.searchParams;
        const providedTh = (params.get('th') || '').trim();
        const providedHmac = (params.get('hmac') || '').trim();
        try {
          const prisma = await getPrisma();
          const row = await prisma.tokenDownload.findFirst({ where: { installerKey: key } });
          if (!row) {
            res.writeHead(410, { 'Content-Type': 'text/plain' });
            res.end('Activation key not recognized.');
            return;
          }
          if (row.expiresAt.getTime() <= Date.now()) {
            res.writeHead(410, { 'Content-Type': 'text/plain' });
            res.end('Activation key expired.');
            return;
          }
          // Persistent rows skip the single-use check entirely — they
          // were created by /tokengen outside a ticket and are meant
          // to be re-runnable indefinitely. row.consumed only matters
          // for normal ticket-scoped tokens.
          const isPersistent = (row as any).persistent === true;
          if (row.consumed && !isPersistent) {
            res.writeHead(410, { 'Content-Type': 'text/plain' });
            res.end('Activation key already used.');
            return;
          }

          // HMAC anti-swap binding — only enforced if this row was
          // generated WITH a binding (legacy rows have nulls and pass).
          const secret = (process.env.HMAC_SECRET || '').trim();
          if (row.expectedHmac && row.ticketHash) {
            if (!providedTh || !providedHmac) {
              res.writeHead(410, { 'Content-Type': 'text/plain' });
              res.end('Activation request missing binding signature.');
              return;
            }
            // 1. Ticket-hash tamper detection: the installer's claimed
            //    ticket hash must match what we stored.
            if (!safeEqual(providedTh, row.ticketHash)) {
              res.writeHead(410, { 'Content-Type': 'text/plain' });
              res.end('Activation key is paired with a different zip.');
              return;
            }
            // 2. Basic HMAC equality: provided must match stored.
            if (!safeEqual(providedHmac, row.expectedHmac)) {
              res.writeHead(410, { 'Content-Type': 'text/plain' });
              res.end('Activation signature does not match.');
              return;
            }
            // 3. Recompute from SECRET + stored data — catches anyone
            //    who tampered with the DB row's expectedHmac directly.
            if (secret && row.appId != null) {
              const payload = `${key}|${row.appId}|${row.ticketHash}`;
              const recomputed = crypto
                .createHmac('sha256', secret)
                .update(payload)
                .digest('hex');
              if (!safeEqual(recomputed, row.expectedHmac)) {
                console.warn('[PayloadServer] HMAC mismatch on validate — DB row may be tampered.');
                res.writeHead(410, { 'Content-Type': 'text/plain' });
                res.end('Activation signature failed cryptographic verification.');
                return;
              }
            }
          }

          // For persistent rows: bump consumedAt for audit but DON'T
          // flip `consumed` — staff /tokengen tokens stay re-runnable.
          // For normal rows: flip both so any further validation 410s.
          await prisma.tokenDownload.update({
            where: { token: row.token },
            data: isPersistent
              ? { consumedAt: new Date() }
              : { consumed: true, consumedAt: new Date() },
          });
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
        } catch (e) {
          console.error('[PayloadServer] /installer-validate error', e);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal error');
          }
        }
        return;
      }

      // ── Self-driving installer: mint token from token_req ──
      // POST /activate/<installerKey>   Body: { "token_req": "<blob>" }
      //
      // The call-home EA/Ubisoft installer POSTs the token_req it captured
      // from the game. We look up the mint context stored on the row, mint the
      // token (same clients the manual ticket flow uses), finalize the Discord
      // ticket, and return token.ini for the installer to drop into the game
      // folder. Single-use: the key is consumed on a successful mint.
      const am = url.pathname.match(/^\/activate\/([a-f0-9]{16,128})$/);
      if (am && req.method === 'POST') {
        if (adminRateLimited(clientIp(req), 30, 60_000)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, code: 'RateLimited', message: 'Too many requests — slow down.' }));
          return;
        }
        const key = am[1];

        const chunks3: Buffer[] = [];
        let total3 = 0;
        let aborted3 = false;
        for await (const chunk of req) {
          chunks3.push(chunk as Buffer);
          total3 += (chunk as Buffer).length;
          if (total3 > 64 * 1024) { aborted3 = true; break; }
        }
        if (aborted3) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, code: 'TooLarge', message: 'Request body too large.' }));
          return;
        }
        const raw = Buffer.concat(chunks3).toString('utf-8');
        let tokenReq = '';
        try {
          const parsed = JSON.parse(raw || '{}');
          tokenReq = String(parsed.token_req || parsed.tokenReq || '').trim();
        } catch {
          tokenReq = raw.trim(); // tolerate a raw text body
        }
        if (!tokenReq || tokenReq.length < 20) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, code: 'BadRequest', message: 'Missing or too-short token_req.' }));
          return;
        }

        try {
          const prisma = await getPrisma();
          const row = await prisma.tokenDownload.findFirst({ where: { installerKey: key } });
          if (!row) {
            res.writeHead(410, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, code: 'Unknown', message: 'Activation key not recognized.' }));
            return;
          }
          if (row.expiresAt.getTime() <= Date.now()) {
            res.writeHead(410, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, code: 'Expired', message: 'Activation key expired. Re-open your ticket on Discord.' }));
            return;
          }
          // Persistent rows are staff test installers — re-runnable, never consumed.
          const isPersistent = (row as any).persistent === true;
          if (row.consumed && !isPersistent) {
            res.writeHead(410, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, code: 'Consumed', message: 'This activation was already completed.' }));
            return;
          }

          const { processInstallerActivation } = await import('./utils/installerActivation');
          const outcome = await processInstallerActivation(row as any, tokenReq);

          if (outcome.consume && !isPersistent) {
            await prisma.tokenDownload
              .update({ where: { token: row.token }, data: { consumed: true, consumedAt: new Date() } })
              .catch(() => {});
          }

          res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
          if (outcome.status === 200) {
            res.end(JSON.stringify({ ok: true, tokenIni: outcome.tokenIni, filename: outcome.filename || 'token.ini' }));
          } else {
            res.end(JSON.stringify({ ok: false, code: outcome.code, message: outcome.message }));
          }
        } catch (e) {
          console.error('[PayloadServer] /activate error', e);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, code: 'Internal', message: 'Internal error' }));
          }
        }
        return;
      }

      // ── Time-limited token download endpoint ──
      // GET /download/<token> → streams the zip if the token is valid
      // and not expired. The bot creates these rows via createDownloadLink()
      // and they auto-expire 30 minutes after creation.
      const dm = url.pathname.match(/^\/download\/([a-f0-9]{8,128})$/);
      if (dm) {
        const token = dm[1];
        try {
          const prisma = await getPrisma();
          const row = await prisma.tokenDownload.findUnique({ where: { token } });
          if (!row) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Link not found or already expired');
            return;
          }
          if (row.expiresAt.getTime() <= Date.now()) {
            res.writeHead(410, { 'Content-Type': 'text/plain' });
            res.end('This download link has expired (30 minute limit). Please re-open your ticket on Discord.');
            return;
          }
          if (!fs.existsSync(row.filePath)) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Stored file is no longer available');
            return;
          }
          const stat = fs.statSync(row.filePath);
          // Mark first claim time for staff stats; don't block on errors.
          if (!row.claimedAt) {
            // Fire-and-forget claim timestamp update.
            getPrisma()
              .then(p => p.tokenDownload.update({ where: { token }, data: { claimedAt: new Date() } }))
              .catch(() => {});
          }
          // Node's http module rejects any non-latin-1 char in header values
          // ("Invalid character in header content"). If the zip name contains
          // ™, ®, em-dashes, accents, or a curly quote (any character from a
          // manually-added game name), passing it raw to Content-Disposition
          // throws → /download responds "Internal error" instead of streaming
          // the file. Build BOTH:
          //   filename="<ascii fallback>"      (legacy clients, plain ASCII)
          //   filename*=UTF-8''<percent-utf8>  (RFC 5987, real name)
          // Browsers prefer filename* when present, so the user still sees
          // the pretty name with the original characters.
          const rawName = row.fileName || 'token.zip';
          const asciiName = rawName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
          const utf8Name = encodeURIComponent(rawName);
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': stat.size.toString(),
            'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          fs.createReadStream(row.filePath).pipe(res);
        } catch (e) {
          console.error('[PayloadServer] /download error', e);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal error');
          }
        }
        return;
      }

      // Per-game override: GET /payload/override/<appid>/<filename>
      // Serves _Core/overrides/<appid>/<filename> so a specific game can
      // ship a different emulator binary than the shared default.
      const om = url.pathname.match(/^\/payload\/override\/([0-9]+)\/([A-Za-z0-9._-]+)$/);
      if (om) {
        const [, appid, filename] = om;
        const overridePath = resolveOverrideFile(appid, filename);
        if (!overridePath) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('File not found');
          return;
        }
        const ostat = fs.statSync(overridePath);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': ostat.size.toString(),
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        });
        fs.createReadStream(overridePath).pipe(res);
        return;
      }

      const m = url.pathname.match(/^\/payload\/([a-z0-9_]+)\/([A-Za-z0-9._-]+)$/);
      if (!m) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const [, mode, filename] = m;
      const filePath = resolveFile(mode, filename);
      if (!filePath) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
        return;
      }

      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size.toString(),
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      console.error('[PayloadServer] request error', err);
      try {
        res.writeHead(500);
        res.end('internal error');
      } catch {}
    }
  });

  server.on('error', (err: Error) => {
    console.error(`[PayloadServer] failed to listen on :${port}`, err.message);
  });

  server.listen(port, () => {
    const publicUrl =
      process.env.PUBLIC_URL ||
      (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
    if (publicUrl) {
      console.log(`[PayloadServer] listening on :${port} (public: ${publicUrl}/payload/...)`);
    } else {
      console.log(`[PayloadServer] listening on :${port} (PUBLIC_URL not set — installer downloads will fail)`);
    }
  });
}
