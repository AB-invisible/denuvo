/**
 * fileHost.ts — Upload large files to a free file host so the bot can
 * deliver tokens that exceed Discord's per-server upload limit.
 *
 * Primary provider: gofile.io
 *   - Free, no signup, no API key needed
 *   - Preserves the original filename (so the user downloads
 *     "Token [Pragmata].zip" instead of "dc9ss9.zip")
 *   - Returns a download PAGE URL; user clicks "Download" on that page
 *   - Files persist 10 days with no activity, longer if downloaded
 *
 * Fallback provider: litterbox.catbox.moe
 *   - Used only if gofile.io is unreachable
 *   - Returns a direct-download URL with a random filename
 *   - 72-hour expiry
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';

export type LitterboxExpiry = '1h' | '12h' | '24h' | '72h';

export interface UploadResult {
  /** The URL to send to the user (download page or direct download). */
  url: string;
  /** Which provider was used. */
  provider: 'gamegen' | 'gofile' | 'litterbox';
  /** Whether the URL is a direct file download (true) or a download page (false). */
  isDirect: boolean;
  /** Human-readable expiry hint shown in messages. */
  expiryText: string;
}

/**
 * Upload to gofile.io. Returns a download-page URL that preserves the
 * original filename. Throws on failure.
 *
 * API flow:
 *   1. GET https://api.gofile.io/servers → pick a store server
 *   2. POST https://{server}.gofile.io/contents/uploadfile (multipart)
 *      → { status: "ok", data: { downloadPage, code, fileName, ... } }
 */
async function uploadToGofile(filePath: string): Promise<UploadResult> {
  // Pick an upload server
  const serverResp = await axios.get('https://api.gofile.io/servers', {
    timeout: 15_000,
    responseType: 'json',
  });
  const servers: any[] = serverResp.data?.data?.servers || [];
  if (!servers.length) {
    throw new Error('gofile.io: no upload servers returned');
  }
  const serverName: string = servers[0].name;
  const uploadUrl = `https://${serverName}.gofile.io/contents/uploadfile`;

  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
  });

  const resp = await axios.post(uploadUrl, form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 5 * 60 * 1000,
    responseType: 'json',
  });

  if (resp.data?.status !== 'ok') {
    throw new Error(`gofile.io returned: ${JSON.stringify(resp.data).slice(0, 200)}`);
  }
  const page = resp.data?.data?.downloadPage;
  if (!page || typeof page !== 'string') {
    throw new Error(`gofile.io: no downloadPage in response`);
  }
  return {
    url: page,
    provider: 'gofile',
    isDirect: false,
    expiryText: 'Link is valid as long as the file is downloaded periodically (10+ days of inactivity expires)',
  };
}

/**
 * Upload to litterbox.catbox.moe. Returns a direct-download URL but the
 * filename in the URL is random — used only as a fallback.
 */
async function uploadToLitterboxRaw(filePath: string, expiry: LitterboxExpiry): Promise<UploadResult> {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('time', expiry);
  form.append('fileToUpload', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
  });

  const response = await axios.post(
    'https://litterbox.catbox.moe/resources/internals/api.php',
    form,
    {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 5 * 60 * 1000,
      responseType: 'text',
    }
  );

  const body = String(response.data || '').trim();
  if (!body.startsWith('http')) {
    throw new Error(`litterbox returned unexpected response: ${body.slice(0, 200)}`);
  }
  return {
    url: body,
    provider: 'litterbox',
    isDirect: true,
    expiryText: `Link expires in ${expiry}`,
  };
}

/**
 * Upload a file to the best available host. Tries gofile.io first
 * (preserves filename); falls back to litterbox.catbox.moe if gofile
 * is unreachable.
 */
export async function uploadFile(
  filePath: string,
  litterboxExpiry: LitterboxExpiry = '72h',
  installerKey?: string,
  bindings?: { ticketHash?: string; expectedHmac?: string; appIdBound?: number },
): Promise<UploadResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    throw new Error(`File is empty: ${filePath}`);
  }
  if (stat.size > 1024 * 1024 * 1024) {
    throw new Error(`File exceeds 1 GB safety limit: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  }

  // Preferred: self-hosted 30-minute link via the bot's /download endpoint.
  // Lazy-imported so a module-load-time failure in downloadHost (e.g.
  // Prisma client init explosion) can't cascade up and prevent fileHost
  // from loading at all. If it throws, we silently fall back to gofile.
  try {
    const { createDownloadLink } = await import('./downloadHost');
    const link = await createDownloadLink(filePath, undefined, installerKey, bindings);
    if (link) {
      return {
        url: link.url,
        provider: 'gamegen',
        isDirect: true,
        expiryText: `Link expires in ${link.expiresInMinutes} minutes — download soon`,
      };
    }
    console.warn('[fileHost] createDownloadLink returned null (no PUBLIC_URL?) — falling back to gofile');
  } catch (selfErr) {
    const se = selfErr as Error;
    console.warn(`[fileHost] createDownloadLink threw, falling back to gofile: ${se.message}`);
  }

  // Try gofile.io next — preserves filename
  try {
    return await uploadToGofile(filePath);
  } catch (gofileErr) {
    const ge = gofileErr as Error;
    console.warn(`[fileHost] gofile.io failed, falling back to litterbox: ${ge.message}`);
  }

  // Last-resort fallback: litterbox.catbox.moe
  return await uploadToLitterboxRaw(filePath, litterboxExpiry);
}

/**
 * Back-compat alias — the old code calls uploadToLitterbox. Now routes through
 * the smart uploader so callers automatically get gofile.io's filename-preserving
 * behavior with litterbox fallback.
 */
export async function uploadToLitterbox(filePath: string, expiry: LitterboxExpiry = '72h'): Promise<string> {
  const result = await uploadFile(filePath, expiry);
  return result.url;
}
