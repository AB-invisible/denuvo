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

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');

      if (url.pathname === '/payload/health' || url.pathname === '/health' || url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
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
