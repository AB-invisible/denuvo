/**
 * Ensure EA magic zip exists on the Railway volume (EA_MAGIC_DIR).
 * Upload once via: tar -cf - -C ea-magic "<file>.zip" | railway ssh -s denuvo -- "mkdir -p /data/ea-magic && tar -xf - -C /data/ea-magic"
 */
import fs from 'fs';
import path from 'path';
import { mkdir } from 'fs/promises';

const dir = (process.env.EA_MAGIC_DIR || '/data/ea-magic').trim();
const file = 'EA SPORTS FC 26 magic files.zip';
const dest = path.join(dir, file);
const minBytes = 10_000_000;

async function main() {
  await mkdir(dir, { recursive: true });
  if (!fs.existsSync(dest)) {
    console.log(`[seed-ea-magic] missing ${dest} — upload zip to the Railway volume (see ea-magic/README.md)`);
    return;
  }
  const size = fs.statSync(dest).size;
  if (size < minBytes) {
    console.log(`[seed-ea-magic] corrupt file (${size} bytes) at ${dest} — re-upload required`);
    fs.unlinkSync(dest);
    return;
  }
  console.log(`[seed-ea-magic] ok: ${dest} (${size} bytes)`);
}

main().catch((e) => {
  console.error('[seed-ea-magic] error:', e?.message || e);
});
