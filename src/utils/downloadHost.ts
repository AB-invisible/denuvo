/**
 * Self-hosted, time-limited download links for token zips.
 *
 * Why this exists: gofile.io / litterbox links live for days. Once a
 * link leaks (Discord chat shared outside the server, friend asks the
 * customer for "the zip you got", etc.) anyone can re-download the
 * token bytes and re-use them for free. This module replaces external
 * file hosts with a bot-controlled URL that:
 *
 *   - Is served by the bot's own /download/<token> endpoint on Railway.
 *   - Expires exactly 30 minutes after creation, no matter how many
 *     times it's been clicked.
 *   - 404s the moment the row is deleted from the DB.
 *
 * The matching HTTP handler lives in src/payloadServer.ts.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { resolvePlatformPublicUrl } from './cloudPublicUrl';

const LINK_TTL_MS = 30 * 60 * 1000; // 30 minutes
// `persistent` links (staff /tokengen outside a ticket) get this far-future
// expiresAt so the download endpoint + cleanup sweep treat them as alive
// effectively forever, without us having to add nullable-expiresAt handling
// to every consumer. Year 2125-ish is well past anything we'd realistically
// keep around.
const PERSISTENT_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

// Lazy-load Prisma so an import-time failure in @prisma/client doesn't
// cascade up the import chain and prevent the whole bot from starting.
// Any caller that doesn't actually use createDownloadLink/cleanup never
// touches the client at all.
async function getPrisma() {
  const mod = await import('../lib/prisma');
  return mod.default;
}

export interface SelfHostedLink {
  url: string;
  expiresAt: Date;
  expiresInMinutes: number;
}

let validatedPublicBaseUrl: string | null | undefined;

function tunnelUrlFilePath(): string {
  const fromEnv = (process.env.PUBLIC_URL_FILE || '').trim();
  if (fromEnv) return fromEnv;
  return path.join(process.cwd(), '..', 'denuvo-data', 'public-url.txt');
}

function readTunnelUrlFile(): string | null {
  const file = tunnelUrlFilePath();
  if (!fs.existsSync(file)) return null;
  try {
    const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.trim()).find(Boolean);
    return line ? normalizeExplicitUrl(line) : null;
  } catch {
    return null;
  }
}

function isTunnelHostname(host: string): boolean {
  const h = host.toLowerCase();
  return h.endsWith('.trycloudflare.com')
    || h.endsWith('.cfargotunnel.com')
    || h.endsWith('.cloudflareaccess.com');
}

function isIpAddressHost(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

function normalizeExplicitUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) return `http://${trimmed}`;
  return trimmed;
}

function isIpUrl(url: string): boolean {
  try {
    return isIpAddressHost(new URL(normalizeExplicitUrl(url)).hostname);
  } catch {
    return true;
  }
}

function localOnlyHost(host: string): boolean {
  if (host === '127.0.0.1' || host === 'localhost') return true;
  return /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

export function resolvePublicBaseUrl(): string | null {
  // Always read the tunnel file first — quick-tunnel URLs change whenever
  // denuvo-tunnel restarts; a startup cache goes stale and breaks downloads.
  const tunnel = readTunnelUrlFile();
  if (tunnel && !isIpUrl(tunnel)) {
    if (tunnel !== validatedPublicBaseUrl) {
      validatedPublicBaseUrl = tunnel;
      process.env.PUBLIC_URL = tunnel;
    }
    return tunnel;
  }

  if (validatedPublicBaseUrl && !isIpUrl(validatedPublicBaseUrl)) {
    return validatedPublicBaseUrl;
  }

  const explicit = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (explicit && !isIpUrl(explicit)) {
    try {
      const host = new URL(normalizeExplicitUrl(explicit)).hostname;
      if (isTunnelHostname(host) || !localOnlyHost(host)) {
        return normalizeExplicitUrl(explicit);
      }
    } catch {
      /* ignore */
    }
  }

  const railway = (process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  if (railway) return 'https://' + railway;

  const platform = resolvePlatformPublicUrl();
  if (platform) return platform;

  return null;
}

/** Strip stale IP-based PUBLIC_URL left in the process environment. */
export function sanitizePublicUrlEnv(): void {
  const explicit = (process.env.PUBLIC_URL || '').trim();
  if (explicit && isIpUrl(explicit)) {
    console.warn(`[downloadHost] Removing stale IP PUBLIC_URL from process env`);
    process.env.PUBLIC_URL = readTunnelUrlFile() || '';
  }
}

/** URL forwarded to Python / shown to users — never a raw public IP. */
export function getPublicUrlForGeneration(): string {
  sanitizePublicUrlEnv();
  return resolvePublicBaseUrl() || '';
}

export function selfHostedDownloadsOnly(): boolean {
  return process.env.SELF_HOSTED_DOWNLOADS !== 'false';
}

/** Validate PUBLIC_URL / Cloudflare tunnel file at startup. */
export async function initPublicUrlValidation(): Promise<void> {
  let explicit = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const tunnelFile = readTunnelUrlFile();

  if (explicit) {
    try {
      const host = new URL(normalizeExplicitUrl(explicit)).hostname;
      if (isIpAddressHost(host)) {
        console.warn(
          `[downloadHost] PUBLIC_URL uses raw IP (${host}) — blocked. ` +
          'Download links will use the Cloudflare tunnel URL only.',
        );
        process.env.PUBLIC_URL = '';
        explicit = '';
      }
    } catch {
      process.env.PUBLIC_URL = '';
      explicit = '';
    }
  }

  const candidate = tunnelFile || (explicit ? normalizeExplicitUrl(explicit) : null);

  if (!candidate) {
    validatedPublicBaseUrl = null;
    if (selfHostedDownloadsOnly()) {
      console.warn(
        '[downloadHost] No Cloudflare tunnel URL yet. Start denuvo-tunnel before generating tokens.',
      );
    }
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    console.warn('[downloadHost] Public URL is invalid');
    validatedPublicBaseUrl = null;
    return;
  }

  const host = parsed.hostname;

  let localServer = false;
  try {
    const health = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(3000) });
    localServer = health.ok;
  } catch {
    localServer = false;
  }

  if (!localServer) {
    console.warn('[downloadHost] Payload server is not listening on port 8080');
    validatedPublicBaseUrl = null;
    return;
  }

  if (isTunnelHostname(host)) {
    validatedPublicBaseUrl = candidate;
    process.env.PUBLIC_URL = candidate;
    try {
      const remote = await fetch(`${candidate.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(8000) });
      if (remote.ok) {
        console.log(`[downloadHost] Download links use Cloudflare tunnel (IP hidden): ${candidate}`);
      } else {
        console.warn(`[downloadHost] Tunnel URL set (${candidate}) but /health returned ${remote.status}`);
      }
    } catch {
      console.warn(`[downloadHost] Tunnel URL set (${candidate}) — waiting for tunnel to become reachable`);
    }
    return;
  }

  if (isIpAddressHost(host)) {
    console.warn('[downloadHost] Refusing to use raw IP for public download links');
    validatedPublicBaseUrl = tunnelFile;
    if (tunnelFile) process.env.PUBLIC_URL = tunnelFile;
    return;
  }

  validatedPublicBaseUrl = candidate;
  process.env.PUBLIC_URL = candidate;
  console.log(`[downloadHost] Download links via: ${candidate}`);
}

let tunnelWatchStarted = false;

/** Re-read public-url.txt when the tunnel service publishes a new URL. */
export function startTunnelUrlWatcher(): void {
  if (tunnelWatchStarted) return;
  tunnelWatchStarted = true;
  const file = tunnelUrlFilePath();
  if (!fs.existsSync(file)) return;

  fs.watch(file, { persistent: false }, () => {
    setTimeout(async () => {
      try {
        validatedPublicBaseUrl = undefined;
        await initPublicUrlValidation();
      } catch (e) {
        console.warn('[downloadHost] Tunnel URL refresh failed:', (e as Error).message);
      }
    }, 500);
  });
  console.log(`[downloadHost] Watching for tunnel URL changes: ${file}`);
}

export type PanelAssetName = 'opensteam.png' | 'gamegen.png' | 'maintenance.png';

/** Public URL for Discord embed images when Railway/PUBLIC_URL is configured. */
export function getPanelAssetUrl(filename: PanelAssetName): string | null {
  const base = resolvePublicBaseUrl();
  return base ? `${base}/assets/${filename}` : null;
}

export function panelImageAttachmentPath(filename: PanelAssetName): string {
  return path.join(__dirname, '..', 'public', filename);
}

/**
 * Where the bot stores zips while they wait to be downloaded. Lives next
 * to the running process so the HTTP handler can read it back. Created
 * lazily on first use.
 */
export function downloadStorageDir(): string {
  const dir = path.join(__dirname, '..', '..', 'Generated_Tokens', '_download_links');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Move (or copy) the zip into the download-storage directory, create a
 * DB row, and return the URL the user clicks. Pass ticketId for staff
 * auditing if the caller has it.
 *
 * `installerKey` (optional): a 48-hex secret the bot pre-generated and
 * already embedded inside the zip's payload-manifest.json as `_sig`.
 * We store it in the same DB row so the bot's
 * POST /installer-validate/<key> endpoint can verify + mark consumed.
 *
 * `persistent` (optional, default false): when true, the link's
 * expiresAt is set ~100 years out so the download stays alive forever,
 * AND /installer-validate skips the consume flip so the installer can
 * be re-run multiple times. Used by /tokengen runs OUTSIDE a ticket
 * channel — staff testing / sharing / ad-hoc generation. Inside a
 * ticket the caller leaves this false so single-use kicks in.
 */
export async function createDownloadLink(
  srcZipPath: string,
  ticketId?: number,
  installerKey?: string,
  bindings?: { ticketHash?: string; expectedHmac?: string; appIdBound?: number },
  persistent: boolean = false,
): Promise<SelfHostedLink | null> {
  const baseUrl = resolvePublicBaseUrl();
  if (!baseUrl) {
    console.warn('[downloadHost] No PUBLIC_URL/RAILWAY_PUBLIC_DOMAIN — cannot create self-hosted link.');
    return null;
  }
  if (!fs.existsSync(srcZipPath)) {
    throw new Error(`File not found: ${srcZipPath}`);
  }

  const token = crypto.randomBytes(24).toString('hex'); // 48 hex chars
  const fileName = path.basename(srcZipPath);
  const storedName = `${token}${path.extname(fileName) || '.zip'}`;
  const storedPath = path.join(downloadStorageDir(), storedName);

  // Use copy then unlink — handles the case where srcZipPath is on a
  // different filesystem (Railway sometimes mounts /tmp separately).
  await fs.promises.copyFile(srcZipPath, storedPath);
  try {
    await fs.promises.unlink(srcZipPath);
  } catch {
    // The caller's own cleanup handles this; not fatal.
  }

  const size = (await fs.promises.stat(storedPath)).size;
  const expiresAt = new Date(Date.now() + (persistent ? PERSISTENT_TTL_MS : LINK_TTL_MS));

  const prisma = await getPrisma();
  await prisma.tokenDownload.create({
    data: {
      token,
      installerKey: installerKey || null,
      ticketHash: bindings?.ticketHash || null,
      expectedHmac: bindings?.expectedHmac || null,
      appId: bindings?.appIdBound ?? null,
      filePath: storedPath,
      fileName,
      fileSize: size,
      expiresAt,
      ticketId: ticketId ?? null,
      // Cast so TS doesn't complain until prisma generate picks up the
      // new column. Schema-side default(false) covers the migration
      // window; this just gives us per-call override.
      ...(persistent ? { persistent: true } : {}),
    } as any,
  });

  return {
    url: `${baseUrl}/download/${token}`,
    expiresAt,
    // -1 = caller should render "permanent" instead of a minute count.
    expiresInMinutes: persistent ? -1 : 30,
  };
}

/**
 * Periodic sweep — deletes expired links + their stored files. Called
 * from the scheduler (every few minutes is plenty since the TTL is 30m).
 */
export async function cleanupExpiredDownloads(): Promise<number> {
  const now = new Date();
  const prisma = await getPrisma();
  const expired = await prisma.tokenDownload.findMany({ where: { expiresAt: { lte: now } } });
  let deleted = 0;
  for (const row of expired) {
    try {
      if (fs.existsSync(row.filePath)) await fs.promises.unlink(row.filePath);
    } catch {}
    try {
      await prisma.tokenDownload.delete({ where: { token: row.token } });
      deleted++;
    } catch {}
  }
  return deleted;
}
