import prisma from '../lib/prisma';
import { logAction } from './logging';
import * as fs from 'fs';
import * as path from 'path';
import { refreshAllPanels } from './panelManager';
import { client } from '../client';
import { CONFIG } from '../config';
import { initServerStocksForGame } from './gameManager';
import { catalogBySteamAppId } from './eaCatalog';

const JSON_PATH = path.join(__dirname, '../../denuvo.json');

/**
 * Syncs games from denuvo.json to the database and refreshes panels if needed.
 */
export async function syncGamesFromFile() {
  try {
    if (!fs.existsSync(JSON_PATH)) {
      console.warn(`[Sync] ${JSON_PATH} not found.`);
      return;
    }

    const denuvoData = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    let changesDetected = false;

    // Get current games to compare
    const currentGames = await prisma.game.findMany();
    const currentGameMap = new Map(currentGames.map(g => [g.name, g]));

    const syncPromises = denuvoData.games.map(async (gameData: any) => {
      const existing = currentGameMap.get(gameData.name);
      const isNew = !existing;
      const isDisabled = gameData.disabled || false;
      const wasDisabled = existing?.disabled ?? true;
      
      if (isNew || (!isDisabled && wasDisabled)) {
         changesDetected = true;
      }

      // generationMode: only set if the JSON specifies it (preserves
      // staff overrides made via /setmode that aren't reflected in JSON).
      const modeUpdate = gameData.generationMode
        ? { generationMode: gameData.generationMode }
        : {};

      const steamAppId = gameData.appId || gameData.appid;
      const catalogEa = steamAppId ? catalogBySteamAppId(Number(steamAppId)) : undefined;
      const eaContentId = gameData.eaContentId ?? catalogEa?.eaContentId ?? undefined;
      const eaEngine = gameData.eaEngine ?? catalogEa?.eaEngine ?? undefined;
      const eaMagicFile = gameData.eaMagicFile ?? catalogEa?.eaMagicFile ?? undefined;
      const eaUpdate =
        eaContentId && eaEngine
          ? { eaContentId, eaEngine, eaMagicFile: eaMagicFile ?? null }
          : {};

      await prisma.game.upsert({
        where: { name: gameData.name },
        update: {
          appId: steamAppId,
          disabled: isDisabled,
          highDemand: gameData.highDemand || false,
          donatorOnly: gameData.donatoronly || gameData.donatorOnly || false,
          boosterOnly: gameData.boosterOnly || false,
          steampassUuid: gameData.steampassUuid || undefined,
          ...modeUpdate,
          ...eaUpdate,
        },
        create: {
          name: gameData.name,
          appId: steamAppId,
          disabled: isDisabled,
          highDemand: gameData.highDemand || false,
          donatorOnly: gameData.donatoronly || gameData.donatorOnly || false,
          boosterOnly: gameData.boosterOnly || false,
          steampassUuid: gameData.steampassUuid || null,
          generationMode: gameData.generationMode || 'gbe',
          stock: 5,
          ...eaUpdate,
        },
      });

      if (isNew) {
        const createdGame = await prisma.game.findUnique({ where: { name: gameData.name } });
        if (createdGame) await initServerStocksForGame(createdGame.id);
        const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
        if (guild) {
          await logAction(guild, '🆕 New Game Detected', `**${gameData.name}** has been automatically added to the system and is now available in the selection panel.`, 0x5865F2);
        }
      } else if (!isDisabled && wasDisabled) {
        const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
        if (guild) {
          await logAction(guild, '🔄 Game Re-enabled', `**${gameData.name}** has been re-enabled in the system and is now back in the selection panel.`, 0x5865F2);
        }
      }
    });

    await Promise.all(syncPromises);

    // Handle game removals (disable games in DB if missing from JSON).
    // BUT — leave manuallyAdded games alone; they live entirely in the DB.
    const gamesInJson = new Set(denuvoData.games.map((g: { name: string }) => g.name));
    for (const game of currentGames) {
      if (!gamesInJson.has(game.name) && !game.disabled && !(game as any).manuallyAdded) {
        await prisma.game.update({
          where: { id: game.id },
          data: { disabled: true }
        });
        changesDetected = true;
        console.log(`[Sync] Game "${game.name}" missing from JSON. Marking as disabled.`);

        const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
        if (guild) {
          await logAction(guild, '🚫 Game Disabled (Missing)', `**${game.name}** was missing from the configuration file and has been automatically disabled.`, 0xED4245);
        }
      }
    }

    if (changesDetected) {
      console.log('[Sync] Changes detected (new or enabled games). Refreshing panels...');
      await refreshAllPanels();
    }
  } catch (err) {
    console.error('Error syncing games from file:', err);
  }
}

/**
 * Initializes a watcher for denuvo.json to automatically sync changes.
 * Also runs a periodic fallback sync in case the watcher misses events (common on Windows).
 */
export function initFileWatcher() {
  console.log(`[Watcher] Starting watch on ${JSON_PATH}`);
  
  let timeout: NodeJS.Timeout | null = null;
  
  const triggerSync = () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(async () => {
      console.log('[Watcher] denuvo.json changed. Syncing...');
      await syncGamesFromFile();
    }, 1000);
  };

  // Windows editors often fire 'rename' instead of 'change'
  fs.watch(JSON_PATH, (eventType) => {
    if (eventType === 'change' || eventType === 'rename') {
      triggerSync();
    }
  });

  // Fallback: periodic re-sync every 5 minutes in case watcher misses events
  setInterval(async () => {
    await syncGamesFromFile();
  }, 5 * 60 * 1000);
}
