/**
 * installerPackage.ts — build + host the self-driving EA/Ubisoft installer.
 *
 * At step 1 of the two-step flow we hand the user a small zip containing
 * installer.exe + a payload-manifest.json (flow: "denuvo-callhome"). The
 * installer reads the manifest, downloads the magic files from the existing
 * /ea|ubisoft/magic route, installs them, launches the game's .exe to capture
 * token_req, then POSTs it to /activate/<installerKey> to get token.ini.
 *
 * The zip is streamed through the SAME /download/<token> endpoint that Steam
 * token zips use — no new HTTP route needed. Mint context (platform, ids) is
 * stored on the TokenDownload row so /activate can mint without re-deriving it.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma';
import { buildStoreZip } from './zipStore';
import { resolvePublicBaseUrl, downloadStorageDir } from './downloadHost';

const CORE_DIR = path.join(__dirname, '..', '..', '_Core');
// The installer must survive: download → install magic → game launch/first-run
// → token_req → mint. 30 min (the Steam link TTL) is too tight; give it 3 h.
const CALLHOME_TTL_MS = 3 * 60 * 60 * 1000;

export type InstallerPlatform = 'ea' | 'ubisoft';

export interface CallhomeManifestInput {
  installerKey: string;
  platform: InstallerPlatform;
  appId: number | null; // Steam appId — used to locate the game folder via Steam manifests
  launchExe?: string | null; // optional relative path to the game binary (else auto-detected)
  gameName: string;
  layout: 'flat' | 'bin64';
  magicUrl: string; // where the installer downloads the setup zip (self-hosted /…/magic or an external mirror)
  baseUrl: string;
  tokenReqNames?: string[];
  test?: boolean; // staff mechanics test — /activate returns a placeholder token, no mint/consume
}

/** The payload-manifest.json the installer reads for the call-home flow. */
export function buildCallhomeManifest(input: CallhomeManifestInput): Record<string, unknown> {
  const base = input.baseUrl.replace(/\/+$/, '');
  return {
    manifest_version: 1,
    flow: 'denuvo-callhome',
    platform: input.platform,
    app_id: input.appId,
    steam_appid: input.appId,
    game_name: input.gameName,
    layout: input.layout,
    base_url: base,
    magic_url: input.magicUrl,
    activate_url: `${base}/activate/${input.installerKey}`,
    token_req_names: input.tokenReqNames && input.tokenReqNames.length ? input.tokenReqNames : ['token_req.txt'],
    ...(input.launchExe ? { launch_exe: input.launchExe } : {}),
    _sig: input.installerKey,
    ...(input.test ? { test: true } : {}),
  };
}

export function installerExePath(): string {
  return path.join(CORE_DIR, 'installer.exe');
}

/** Assemble the delivery zip (installer.exe + manifest). Returns null if installer.exe hasn't been built yet. */
export function buildInstallerZip(manifest: Record<string, unknown>): Buffer | null {
  const exePath = installerExePath();
  if (!fs.existsSync(exePath)) return null;
  const exe = fs.readFileSync(exePath);
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  return buildStoreZip([
    { name: 'payload-manifest.json', data: manifestBuf },
    { name: 'installer.exe', data: exe },
  ]);
}

function sanitizeName(name: string): string {
  return name.replace(/[^\x20-\x7E]/g, '').replace(/[\\/:*?"<>|]/g, '').trim() || 'Game';
}

export interface CallhomeInstallerInput {
  ticketId: number | null;
  guildId: string | null;
  gameName: string;
  appId: number | null;
  launchExe?: string | null;
  layout: 'flat' | 'bin64';
  platform: InstallerPlatform;
  magicUrl: string;
  eaContentId?: number | null;
  eaEngine?: string | null;
  ubisoftAppId?: number | null;
  ubisoftAltAppId?: number | null;
  tokenReqNames?: string[];
  test?: boolean;
}

export type CallhomeInstallerResult =
  | { ok: true; url: string; expiresAt: Date; installerKey: string; fileName: string }
  | { ok: false; reason: 'no_base_url' | 'installer_missing' };

/**
 * Build the installer zip, store it for /download, and persist the mint context
 * on a TokenDownload row. Returns the download link the user clicks.
 */
export async function createCallhomeInstaller(input: CallhomeInstallerInput): Promise<CallhomeInstallerResult> {
  const base = resolvePublicBaseUrl();
  if (!base) return { ok: false, reason: 'no_base_url' };

  const installerKey = crypto.randomBytes(24).toString('hex'); // 48 hex
  const manifest = buildCallhomeManifest({
    installerKey,
    platform: input.platform,
    appId: input.appId,
    launchExe: input.launchExe,
    gameName: input.gameName,
    layout: input.layout,
    magicUrl: input.magicUrl,
    baseUrl: base,
    tokenReqNames: input.tokenReqNames,
    test: input.test,
  });

  const zip = buildInstallerZip(manifest);
  if (!zip) return { ok: false, reason: 'installer_missing' };

  const token = crypto.randomBytes(24).toString('hex');
  const fileName = `GameGen Activate ${input.test ? '(TEST) ' : ''}${sanitizeName(input.gameName)}.zip`;
  const storedPath = path.join(downloadStorageDir(), `${token}.zip`);
  await fs.promises.writeFile(storedPath, zip);

  const expiresAt = new Date(Date.now() + CALLHOME_TTL_MS);
  await prisma.tokenDownload.create({
    data: {
      token,
      installerKey,
      filePath: storedPath,
      fileName,
      fileSize: zip.length,
      expiresAt,
      ticketId: input.ticketId ?? null,
      appId: input.appId ?? null,
      // New call-home columns — cast until `prisma generate` picks them up.
      platform: input.platform,
      eaContentId: input.eaContentId ?? null,
      eaEngine: input.eaEngine ?? null,
      ubisoftAppId: input.ubisoftAppId ?? null,
      ubisoftAltAppId: input.ubisoftAltAppId ?? null,
      guildId: input.guildId ?? null,
      // Test installers are re-runnable + never mint a real token.
      ...(input.test ? { persistent: true } : {}),
    } as any,
  });

  return { ok: true, url: `${base}/download/${token}`, expiresAt, installerKey, fileName };
}
