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

function resolveBaseUrl(): string | null {
  const explicit = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (explicit) {
    if (!/^https?:\/\//i.test(explicit)) return 'https://' + explicit;
    return explicit;
  }
  const railway = (process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  if (railway) return 'https://' + railway;
  return null;
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
  const baseUrl = resolveBaseUrl();
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
