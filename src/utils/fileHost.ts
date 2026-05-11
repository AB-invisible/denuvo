/**
 * fileHost.ts — Upload large files to a free file host so the bot can
 * deliver tokens that exceed Discord's per-server upload limit.
 *
 * Default provider: litterbox.catbox.moe
 *   - Free, no signup
 *   - Max size 1 GB
 *   - Expiry options: 1h, 12h, 24h, 72h (auto-deletes on the server)
 *   - 72h is a good default for our use case: long enough for the user to
 *     download, short enough that ticket files don't linger on the internet
 *
 * Endpoint:
 *   POST https://litterbox.catbox.moe/resources/internals/api.php
 *   multipart/form-data:
 *     reqtype=fileupload
 *     time=1h|12h|24h|72h
 *     fileToUpload=<binary>
 *
 * Returns the direct download URL as plain text on success.
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';

export type Expiry = '1h' | '12h' | '24h' | '72h';

/**
 * Upload a file to litterbox.catbox.moe and return the public URL.
 * Throws on failure.
 */
export async function uploadToLitterbox(filePath: string, expiry: Expiry = '72h'): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    throw new Error(`File is empty: ${filePath}`);
  }
  if (stat.size > 1024 * 1024 * 1024) {
    throw new Error(`File exceeds litterbox 1 GB limit: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  }

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
      timeout: 5 * 60 * 1000, // 5 min upload timeout for large files
      responseType: 'text',
    }
  );

  const body = String(response.data || '').trim();
  if (body.startsWith('https://') || body.startsWith('http://')) {
    return body;
  }
  throw new Error(`Litterbox upload returned unexpected response: ${body.slice(0, 200)}`);
}
