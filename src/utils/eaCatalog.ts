/**
 * eaCatalog.ts — EA / Origin Denuvo game metadata.
 *
 * Games become EA titles when `eaContentId` + `eaEngine` are set on the Game row
 * (via /eagame). Optional `eaMagicFile` names the setup zip for the two-step flow.
 */

import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config';

export type EaLayout = 'flat' | 'bin64';

export interface EaCatalogEntry {
  steamAppId?: number;
  eaContentId: number;
  eaEngine: string;
  eaMagicFile?: string;
  /** Filenames / globs the game writes after launch (installer watches these). */
  eaTokenReqNames?: string[];
  /**
   * Exact game binary to launch (relative to the game folder) so token_req is
   * generated. Without this the installer auto-detects and can pick the EA
   * launcher, which bounces to the EA app instead of running the game itself.
   */
  launchExe?: string;
  /** Direct download when no local zip is hosted (e.g. Pixeldrain). */
  eaMagicUrl?: string;
  layout?: EaLayout;
}

/** Known EA Denuvo titles — extend via /eagame set. */
export const EA_CATALOG: EaCatalogEntry[] = [
  {
    steamAppId: 3405690,
    eaContentId: 16425677,
    // FC 26 tickets use TICKET|0|16425677 — content id is the third segment.
    eaEngine: '0',
    eaMagicFile: 'EA SPORTS FC 26 magic files.zip',
    eaTokenReqNames: ['token_req.txt', 'Denuvo_ticket*.txt'],
    // Run the game binary directly so the crack emits token_req instead of
    // handing off to the EA app. FC26 ships FC26.exe in the game root.
    launchExe: 'FC26.exe',
    layout: 'flat',
  },
];

export function resolveMagicDir(): string {
  const env = (CONFIG.EA_MAGIC_DIR || '').trim();
  if (env) return env;
  return path.join(__dirname, '..', '..', 'ea-magic');
}

export function catalogBySteamAppId(steamAppId: number): EaCatalogEntry | undefined {
  return EA_CATALOG.find((e) => e.steamAppId === steamAppId);
}

export function catalogByMagicFile(filename: string): EaCatalogEntry | undefined {
  const norm = normalizeMagicFilename(filename);
  return EA_CATALOG.find((e) => e.eaMagicFile && normalizeMagicFilename(e.eaMagicFile) === norm);
}

export function normalizeMagicFilename(name: string): string {
  return name.trim().toLowerCase().replace(/\\/g, '/').split('/').pop() || '';
}

export function resolveEaForGame(game: {
  appId?: number | null;
  eaContentId?: number | null;
  eaEngine?: string | null;
  eaMagicFile?: string | null;
}): { eaContentId: number; eaEngine: string; magicFile: string | null; magicUrl: string | null; layout: EaLayout; tokenReqNames: string[]; launchExe: string | null } | null {
  const catalog = game.appId ? catalogBySteamAppId(game.appId) : undefined;
  const eaContentId = game.eaContentId ?? catalog?.eaContentId ?? null;
  const eaEngine = (game.eaEngine ?? catalog?.eaEngine ?? '').trim() || null;
  if (!eaContentId || !eaEngine) return null;

  const magicFile = game.eaMagicFile ?? catalog?.eaMagicFile ?? null;
  const magicUrl = catalog?.eaMagicUrl ?? null;
  const layout = catalog?.layout ?? 'flat';
  const tokenReqNames = catalog?.eaTokenReqNames ?? ['token_req.txt', 'Denuvo_ticket*.txt'];
  const launchExe = catalog?.launchExe ?? null;
  return { eaContentId, eaEngine, magicFile, magicUrl, layout, tokenReqNames, launchExe };
}

export function isEaGame(game: {
  eaContentId?: number | null;
  eaEngine?: string | null;
  appId?: number | null;
}): boolean {
  if (game.eaContentId && game.eaEngine) return true;
  return !!(game.appId && catalogBySteamAppId(game.appId)?.eaContentId);
}

export function locateMagicZip(
  dir: string,
  magicFile: string | null,
  catalog?: EaCatalogEntry,
): { path: string; filename: string } | null {
  if (!dir || !fs.existsSync(dir)) return null;
  const candidates = new Set<string>();
  if (magicFile) candidates.add(magicFile);
  if (catalog?.eaMagicFile) candidates.add(catalog.eaMagicFile);
  for (const name of candidates) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return { path: p, filename: name };
  }
  const files = fs.readdirSync(dir);
  for (const name of files) {
    if (!name.toLowerCase().endsWith('.zip')) continue;
    if (magicFile && normalizeMagicFilename(name) === normalizeMagicFilename(magicFile)) {
      return { path: path.join(dir, name), filename: name };
    }
  }
  return null;
}

export function resolveMagicFile(magicDir: string, contentId: string): { filePath: string; downloadName: string } | null {
  if (!magicDir || !fs.existsSync(magicDir)) return null;
  for (const entry of EA_CATALOG) {
    if (String(entry.eaContentId) !== contentId || !entry.eaMagicFile) continue;
    const located = locateMagicZip(magicDir, entry.eaMagicFile, entry);
    if (located) return { filePath: located.path, downloadName: located.filename };
  }
  for (const name of fs.readdirSync(magicDir)) {
    if (name.toLowerCase().includes(contentId) && name.toLowerCase().endsWith('.zip')) {
      return { filePath: path.join(magicDir, name), downloadName: name };
    }
  }
  return null;
}
