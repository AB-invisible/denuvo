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
import fs from 'fs';
import path from 'path';

const CORE_DIR = path.join(__dirname, '..', '_Core');

// Lazy Prisma loader — same pattern as downloadHost.ts. Keeps a module-
// load-time failure in @prisma/client from blowing up the HTTP server's
// import chain before it can even bind a port.
async function getPrisma() {
  const mod = await import('./lib/prisma');
  return mod.default;
}

// Map URL "mode" segment → sub-directory under _Core/
const MODE_DIRS: Record<string, string> = {
  gbe: '',
  v1: 'coldclientloader',
};

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

      // ── Installer activation-key validation ──────────────
      // POST /installer-validate/<key>
      // The installer.exe reads its embedded `_sig` from
      // payload-manifest.json and POSTs it here on first run. We:
      //   - 410 if key is unknown, expired, or already consumed
      //   - 200 if valid → flip consumed=true so re-runs (and
      //     shared-zip runs by other users) all get rejected
      const vm = url.pathname.match(/^\/installer-validate\/([a-f0-9]{8,128})$/);
      if (vm && (req.method === 'POST' || req.method === 'GET')) {
        const key = vm[1];
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
          if (row.consumed) {
            res.writeHead(410, { 'Content-Type': 'text/plain' });
            res.end('Activation key already used.');
            return;
          }
          await prisma.tokenDownload.update({
            where: { token: row.token },
            data: { consumed: true, consumedAt: new Date() },
          });
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
        } catch (e) {
          console.error('[PayloadServer] /installer-validate error', e);
          if (!res.headersSent) {
            // 5xx, not 4xx — the installer treats network/server errors
            // as retryable, only 4xx triggers self-destruct.
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal error');
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
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': stat.size.toString(),
            'Content-Disposition': `attachment; filename="${row.fileName.replace(/"/g, '')}"`,
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
