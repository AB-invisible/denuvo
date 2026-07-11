/**
 * ubisoftCatalog.ts — static Steam ⇄ Ubisoft mapping for Denuvo/Uplay games.
 *
 * A game becomes a "Ubisoft game" (two-step magic-files + token_req flow)
 * when it has a Ubisoft AppID. The runtime source of truth is the Game row
 * (`ubisoftAppId`, `ubisoftAltAppId`, `ubisoftMagicFile`); this catalog
 * seeds those columns and maps a Steam AppID → the crack/"magic files" zip
 * to serve, so games added from denuvo.json don't need manual wiring.
 *
 * The DenuvoTicket CLI accepts ANY Ubisoft AppID, so this list is only a
 * convenience seed — new games work by setting the columns via /ubisoftgame
 * without editing this file.
 *
 * `layout`:
 *   - "flat"   → magic files (dbdata.dll, steam_api64.dll, steamclient64.dll,
 *                upc_r2*, steam_settings/) drop next to the game .exe.
 *   - "bin64"  → they live under Bin/Win64/ (ANNO 117 style); the zip already
 *                carries that structure, so the user extracts at the game root.
 *
 * `ubisoftAppId` / `ubisoftAltAppId` may be null when unknown — those games
 * are wired for hosting/flow but need an AppID set (via /ubisoftgame or here)
 * before minting can succeed.
 */

import fs from 'fs';
import path from 'path';

/**
 * Directory the magic-files zips are served from. Prefers UBISOFT_MAGIC_DIR
 * (e.g. a Railway volume), but falls back to the repo-committed `ubisoft-magic/`
 * folder so hosting works out-of-the-box on deploy with zero configuration.
 * (__dirname here is src/utils, so ../.. is the repo root.)
 */
export function resolveMagicDir(): string {
  const env = (process.env.UBISOFT_MAGIC_DIR || '').trim();
  if (env) return env;
  return path.join(__dirname, '..', '..', 'ubisoft-magic');
}

export interface UbisoftCatalogEntry {
  /** Human name (matches the Game.name where possible). */
  name: string;
  /** Steam AppID the bot's panel/game uses as its primary key. */
  steamAppId: number;
  /** Primary Ubisoft AppID (tried first). null = unknown, must be set. */
  ubisoftAppId: number | null;
  /** Fallback Ubisoft AppID the tool tries if the primary isn't owned. */
  ubisoftAltAppId: number | null;
  /** Filename of the magic-files zip served to the user. */
  magicFile: string;
  /** Where the magic files go relative to the game install. */
  layout: 'flat' | 'bin64';
}

export const UBISOFT_CATALOG: UbisoftCatalogEntry[] = [
  {
    name: "Assassin's Creed Shadows",
    steamAppId: 3159330,
    ubisoftAppId: 8006,
    ubisoftAltAppId: 1081,
    magicFile: "Assassin's Creed Shadows Magic Files.zip",
    layout: 'flat',
  },
  {
    name: 'Star Wars Outlaws',
    steamAppId: 2842040,
    ubisoftAppId: 17903,
    ubisoftAltAppId: 64181,
    magicFile: 'Star Wars Outlaws Magic Files.zip',
    layout: 'flat',
  },
  {
    name: 'Prince of Persia: The Lost Crown',
    steamAppId: 2751000,
    ubisoftAppId: 6145,
    ubisoftAltAppId: 7021,
    magicFile: 'Prince Of Persia The Lost Crown Magic Files.zip',
    layout: 'flat',
  },
  {
    // 6245 is the only numeric Uplay ID published for Anno 117 (registry
    // labels it "Steam Demo"); the retail full-game ID isn't documented and
    // the crack's upc_r2.ini identifies the game by GUID, not a numeric ID.
    // DenuvoTicket normally reads the AppID embedded in the user's token_req,
    // so this is a best-effort hint — override via /ubisoftgame if a real
    // ticket reveals a different ID. Steam AppID: 3274580.
    name: 'ANNO 117',
    steamAppId: 3274580,
    ubisoftAppId: 6245,
    ubisoftAltAppId: null,
    magicFile: 'ANNO 117 Magic Files.zip',
    layout: 'bin64',
  },
  {
    // Uplay registry: 4553 = native Ubisoft Connect build, 4554 = Steam-integrated
    // build (mirrors AC Shadows 8006/1081). GameId GUID from public Uplay
    // configuration fixtures. Steam AppID: 916440. Files go under Bin/Win64/.
    name: 'Anno 1800',
    steamAppId: 916440,
    ubisoftAppId: 4554,
    ubisoftAltAppId: 4553,
    magicFile: 'Anno 1800 Magic Files.zip',
    layout: 'bin64',
  },
  {
    // Uplay registry: 65043 = "Assassin's Creed Black Flag Resynced"
    // (Ubisoft Connect / Epic build). 66088 is the Steam build's Uplay
    // product ID (from its savegame-folder ID) — used as the alt so the tool
    // tries both, mirroring the AC Shadows 8006/1081 (Ubisoft/Steam) pattern.
    name: "Assassin's Creed Black Flag Resynced",
    steamAppId: 3751950,
    ubisoftAppId: 65043,
    ubisoftAltAppId: 66088,
    magicFile: "Assassin's Creed Black Flag Resynced Magic Files.zip",
    layout: 'flat',
  },
];

const LEGACY_MAGIC_SUFFIX = ' Not A Crack Files.zip';
const CURRENT_MAGIC_SUFFIX = ' Magic Files.zip';

/** Map pre-rename zip filenames stored in DB to the current on-disk names. */
export function normalizeMagicFilename(name: string): string {
  if (name.endsWith(LEGACY_MAGIC_SUFFIX)) {
    return name.slice(0, -LEGACY_MAGIC_SUFFIX.length) + CURRENT_MAGIC_SUFFIX;
  }
  return name;
}

/** Candidate zip names to try on disk (DB override, normalized, catalog, legacy). */
export function magicFilenameCandidates(
  magicFile: string | null | undefined,
  catalog?: UbisoftCatalogEntry,
): string[] {
  const out: string[] = [];
  const add = (n?: string | null) => {
    if (n && !out.includes(n)) out.push(n);
  };
  add(magicFile);
  if (magicFile) add(normalizeMagicFilename(magicFile));
  add(catalog?.magicFile);
  if (catalog?.magicFile) {
    add(
      catalog.magicFile.slice(0, -CURRENT_MAGIC_SUFFIX.length) + LEGACY_MAGIC_SUFFIX,
    );
  }
  return out;
}

/** Find the first magic-files zip that exists under `magicDir`. */
export function locateMagicZip(
  magicDir: string,
  magicFile: string | null | undefined,
  catalog?: UbisoftCatalogEntry,
): { path: string; filename: string } | null {
  if (!magicDir || !fs.existsSync(magicDir)) return null;
  const root = path.resolve(magicDir);
  for (const name of magicFilenameCandidates(magicFile, catalog)) {
    const resolved = path.resolve(path.join(root, name));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) continue;
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return { path: resolved, filename: name };
    }
  }
  return null;
}

export function catalogBySteamAppId(steamAppId: number): UbisoftCatalogEntry | undefined {
  if (!steamAppId) return undefined;
  return UBISOFT_CATALOG.find((e) => e.steamAppId === steamAppId);
}

export function catalogByMagicFile(magicFile: string): UbisoftCatalogEntry | undefined {
  return UBISOFT_CATALOG.find(
    (e) => e.magicFile === magicFile || e.magicFile === normalizeMagicFilename(magicFile),
  );
}

/**
 * Resolve the effective Ubisoft config for a Game row. Prefers the row's
 * own columns (staff can override via /ubisoftgame), then falls back to the
 * static catalog keyed by the game's Steam AppID.
 *
 * Returns null when the game has no Ubisoft AppID from either source — i.e.
 * it's a regular Steam game and should use the normal flow.
 */
export interface ResolvedUbisoft {
  ubisoftAppId: number;
  ubisoftAltAppId: number | null;
  magicFile: string | null;
  layout: 'flat' | 'bin64';
}

export function resolveUbisoftForGame(game: {
  appId?: number | null;
  ubisoftAppId?: number | null;
  ubisoftAltAppId?: number | null;
  ubisoftMagicFile?: string | null;
}): ResolvedUbisoft | null {
  const catalog = game.appId ? catalogBySteamAppId(game.appId) : undefined;

  const ubisoftAppId = game.ubisoftAppId ?? catalog?.ubisoftAppId ?? null;
  if (!ubisoftAppId) return null;

  const magicFileRaw = game.ubisoftMagicFile ?? catalog?.magicFile ?? null;
  const magicFile = magicFileRaw ? normalizeMagicFilename(magicFileRaw) : null;
  const ubisoftAltAppId = game.ubisoftAltAppId ?? catalog?.ubisoftAltAppId ?? null;
  const layout = catalog?.layout ?? 'flat';

  return { ubisoftAppId, ubisoftAltAppId, magicFile, layout };
}

/** True when the game should use the Ubisoft two-step flow. */
export function isUbisoftGame(game: {
  appId?: number | null;
  ubisoftAppId?: number | null;
}): boolean {
  if (game.ubisoftAppId) return true;
  return !!(game.appId && catalogBySteamAppId(game.appId)?.ubisoftAppId);
}
