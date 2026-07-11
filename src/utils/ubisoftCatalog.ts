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
    magicFile: "Assassin's Creed Shadows Not A Crack Files.zip",
    layout: 'flat',
  },
  {
    name: 'Star Wars Outlaws',
    steamAppId: 2842040,
    ubisoftAppId: 17903,
    ubisoftAltAppId: 64181,
    magicFile: 'Star Wars Outlaws Not A Crack Files.zip',
    layout: 'flat',
  },
  {
    name: 'Prince of Persia: The Lost Crown',
    steamAppId: 2751000,
    ubisoftAppId: 6145,
    ubisoftAltAppId: 7021,
    magicFile: 'Prince Of Persia The Lost Crown Not A Crack Files.zip',
    layout: 'flat',
  },
  {
    // Ubisoft AppID unknown — set via /ubisoftgame once known.
    name: 'ANNO 117',
    steamAppId: 0,
    ubisoftAppId: null,
    ubisoftAltAppId: null,
    magicFile: 'ANNO 117 Not A Crack Files.zip',
    layout: 'bin64',
  },
  {
    // Ubisoft AppID unknown — set via /ubisoftgame once known. Steam AppID
    // per handoff; owner already registered an owned Steam account for it.
    name: "Assassin's Creed Black Flag Resynced",
    steamAppId: 3751950,
    ubisoftAppId: null,
    ubisoftAltAppId: null,
    magicFile: "Assassin's Creed Black Flag Resynced Not A Crack Files.zip",
    layout: 'flat',
  },
];

export function catalogBySteamAppId(steamAppId: number): UbisoftCatalogEntry | undefined {
  if (!steamAppId) return undefined;
  return UBISOFT_CATALOG.find((e) => e.steamAppId === steamAppId);
}

export function catalogByMagicFile(magicFile: string): UbisoftCatalogEntry | undefined {
  return UBISOFT_CATALOG.find((e) => e.magicFile === magicFile);
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

  const magicFile = game.ubisoftMagicFile ?? catalog?.magicFile ?? null;
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
