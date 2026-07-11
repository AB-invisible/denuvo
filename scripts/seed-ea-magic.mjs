/**
 * Seed EA magic zips onto persistent storage when missing (Railway volume).
 */
import fs from 'fs';
import path from 'path';
import { mkdir } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const dir = (process.env.EA_MAGIC_DIR || '/data/ea-magic').trim();
const file = 'EA SPORTS FC 26 magic files.zip';
const dest = path.join(dir, file);
const url = (process.env.EA_MAGIC_SEED_URL || '').trim();

async function main() {
  if (fs.existsSync(dest)) {
    const size = fs.statSync(dest).size;
    console.log(`[seed-ea-magic] already present: ${dest} (${size} bytes)`);
    return;
  }
  if (!url) {
    console.log(`[seed-ea-magic] no EA_MAGIC_SEED_URL — zip missing at ${dest}`);
    return;
  }

  await mkdir(dir, { recursive: true });
  console.log(`[seed-ea-magic] downloading ${url} → ${dest}`);

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status}`);
  }

  const nodeStream = Readable.fromWeb(res.body);
  await pipeline(nodeStream, fs.createWriteStream(dest));

  const size = fs.statSync(dest).size;
  console.log(`[seed-ea-magic] done (${size} bytes)`);
}

main().catch((e) => {
  console.error('[seed-ea-magic] error:', e?.message || e);
  process.exit(0);
});
