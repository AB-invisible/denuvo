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
  layout?: EaLayout;
}

/** Known EA Denuvo titles — extend via /eagame set. */
export const EA_CATALOG: EaCatalogEntry[] = [
  {
    steamAppId: 3405690,
    eaContentId: 16425677,
    // FC 26 tickets use TICKET|0|16425677 — content id is the third segment.
    eaEngine: '0',
    eaMagicFile: 'FC26 Magic Files.zip',
    layout: 'flat',
  },
];

export function resolveMagicDir(): string {
  return (CONFIG.EA_MAGIC_DIR || '').trim();
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
}): { eaContentId: number; eaEngine: string; magicFile: string | null; layout: EaLayout } | null {
  const catalog = game.appId ? catalogBySteamAppId(game.appId) : undefined;
  const eaContentId = game.eaContentId ?? catalog?.eaContentId ?? null;
  const eaEngine = (game.eaEngine ?? catalog?.eaEngine ?? '').trim() || null;
  if (!eaContentId || !eaEngine) return null;

  const magicFile = game.eaMagicFile ?? catalog?.eaMagicFile ?? null;
  const layout = catalog?.layout ?? 'flat';
  return { eaContentId, eaEngine, magicFile, layout };
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
