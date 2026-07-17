import prisma from '../lib/prisma';
import { Game, Prisma, ServerStock } from '@prisma/client';
import { logGlobal, logStockNotification } from './logging';
import { notifySubscribers } from './subscriptionManager';
import { notifyWaitlist } from './waitlistManager';
import { getAllowedGuildIds } from './tenant';
import { CONFIG } from '../config';
import {
  usesAccountSyncedStock,
  syncStockForGame,
  computeRemainingDailyTokens,
  resolveOwnerManualStock,
  getDefaultStockForApp,
} from './accountCapacity';
import { isUbisoftGame } from './ubisoftCatalog';
import { isEaGame } from './eaCatalog';

export const REGEN_TIME = 24 * 60 * 60 * 1000; // 24 hours

export async function getOrCreateServerStock(gameId: number, guildId: string): Promise<ServerStock> {
  const existing = await prisma.serverStock.findUnique({
    where: { gameId_guildId: { gameId, guildId } },
  });
  if (existing) return existing;

  const defaultStock = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  return prisma.serverStock.create({
    data: { gameId, guildId, stock: defaultStock, maxStock: defaultStock },
  });
}

export async function getServerStockMapForGuild(
  guildId: string,
): Promise<Map<number, { stock: number; lastDepletedAt: Date | null; cycleStartedAt: Date | null; maxStock: number }>> {
  const stocks = await prisma.serverStock.findMany({ where: { guildId } });
  return new Map(
    stocks.map((s) => [
      s.gameId,
      { stock: s.stock, lastDepletedAt: s.lastDepletedAt, cycleStartedAt: s.cycleStartedAt, maxStock: s.maxStock },
    ]),
  );
}

/**
 * Refill every game whose 24h cycle has elapsed.
 *
 * A game's cycle starts the moment its FIRST token is used. The whole game
 * returns to maxStock at cycleStartedAt + 24h no matter how many were used in
 * between, and each game clocks independently:
 *
 *   Crimson Desert — first token 5pm, another at 7pm → refills tomorrow 5pm
 *   The Bus        — first token 6pm                 → refills tomorrow 6pm
 *
 * Pass a guildId to sweep one server, or omit it to sweep them all (the 5-min
 * scheduler job). Also supersedes the old per-token Restock rows + heal pass, so
 * anything left stuck at 0 by the previous models recovers on the first run.
 */
/**
 * Adopt rows depleted under the OLD models into the cycle model.
 *
 * Anything drained before cycleStartedAt existed has it NULL, which both hides
 * the panel countdown and — worse — makes processStockCycles() skip the row
 * forever (its filter is `not: null`), so those games would never refill again.
 *
 * Derive the real start from the best evidence available, in order:
 *   1. Oldest pending Restock row — the old model wrote restockAt = used + 24h,
 *      so restockAt - 24h IS the moment the first token went out.
 *   2. lastDepletedAt — when it hit zero.
 *   3. now — nothing better; start the clock fresh.
 *
 * Rows already at/above maxStock have nothing to refill, so they just stay
 * cycle-less. Idempotent: once stamped, a row is never re-adopted.
 */
async function adoptLegacyCycles(guildId?: string): Promise<void> {
  const orphans = await prisma.serverStock.findMany({
    where: {
      ...(guildId !== undefined ? { guildId } : {}),
      cycleStartedAt: null,
    },
    include: { game: true },
  });
  if (orphans.length === 0) return;

  for (const s of orphans) {
    if (s.stock >= s.maxStock) continue; // full — nothing owed
    if (s.game.excludeRegen) continue; // never auto-refills

    const oldestRestock = await prisma.restock.findFirst({
      where: { gameId: s.gameId, guildId: s.guildId },
      orderBy: { restockAt: 'asc' },
      select: { restockAt: true },
    });

    const startedAt = oldestRestock
      ? new Date(oldestRestock.restockAt.getTime() - REGEN_TIME)
      : (s.lastDepletedAt ?? new Date());

    await prisma.serverStock.update({
      where: { gameId_guildId: { gameId: s.gameId, guildId: s.guildId } },
      data: { cycleStartedAt: startedAt },
    });

    // Burn the legacy rows now they're translated — leaving them would let a
    // future cycle-less state (e.g. after /stock remove) read an ancient
    // restockAt and refill instantly.
    if (oldestRestock) {
      await prisma.restock.deleteMany({ where: { gameId: s.gameId, guildId: s.guildId } });
    }
    console.log(
      `[Stock] Adopted "${s.game.name}" into the cycle model (started ${startedAt.toISOString()}, stock ${s.stock}/${s.maxStock}).`,
    );
  }
}

export async function processStockCycles(guildId?: string): Promise<void> {
  // Pull pre-migration rows in first, or they'd never refill and would show no
  // countdown. Anything already past its 24h gets refilled by the sweep below.
  await adoptLegacyCycles(guildId);

  const cutoff = new Date(Date.now() - REGEN_TIME);
  const due = await prisma.serverStock.findMany({
    where: {
      ...(guildId !== undefined ? { guildId } : {}),
      cycleStartedAt: { not: null, lte: cutoff },
    },
    include: { game: true },
  });
  if (due.length === 0) return;

  for (const s of due) {
    const target = s.maxStock;

    // excludeRegen games never auto-refill — just close the cycle so the panel
    // stops showing a countdown that will never fire.
    if (s.game.excludeRegen || target <= s.stock) {
      await prisma.serverStock.update({
        where: { gameId_guildId: { gameId: s.gameId, guildId: s.guildId } },
        data: { cycleStartedAt: null },
      });
      continue;
    }

    const previousStock = s.stock;
    await prisma.serverStock.update({
      where: { gameId_guildId: { gameId: s.gameId, guildId: s.guildId } },
      data: { stock: target, cycleStartedAt: null, lastDepletedAt: null },
    });

    await logGlobal(
      '✅ Auto-Restock',
      `**${s.game.name}** refilled to **${target}** token(s) — 24h cycle complete.`,
      0x57F287,
    );
    await notifyStockRestocked(s.gameId, s.game.name, previousStock, target);
  }
}

export async function initServerStocksForGame(gameId: number): Promise<void> {
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  const guildIds = await getAllowedGuildIds();
  for (const guildId of guildIds) {
    const stock = game?.appId
      ? await getDefaultStockForApp(game.appId, guildId)
      : CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
    await prisma.serverStock.upsert({
      where: { gameId_guildId: { gameId, guildId } },
      update: {},
      create: { gameId, guildId, stock },
    });
  }
}

export async function getActiveGames() {
  return prisma.game.findMany({
    where: { disabled: false },
    orderBy: { name: 'asc' },
  });
}

export async function getGameByName(name: string) {
  return prisma.game.findUnique({
    where: { name, disabled: false },
  });
}

/** DM subscribers + queued users when stock rises for a game. */
export async function notifyStockRestocked(
  gameId: number,
  gameName: string,
  previousStock: number,
  newStock: number,
): Promise<void> {
  const delta = newStock - previousStock;
  if (delta <= 0) return;
  await notifySubscribers(gameId, gameName, delta);
  await notifyWaitlist(gameId, gameName, previousStock, newStock);
}

export async function updateStock(gameName: string, sub: 'add' | 'remove' | 'set' | 'clear', amount: number = 0, guildId: string = '') {
  const game = await prisma.game.findUnique({ where: { name: gameName } });
  if (!game) throw new Error(`Game "${gameName}" not found.`);

  const serverStock = await getOrCreateServerStock(game.id, guildId);
  const previousStock = serverStock.stock;

  let newStock: number;
  if (sub === 'add') {
    newStock = serverStock.stock + amount;
  } else if (sub === 'remove') {
    newStock = Math.max(0, serverStock.stock - amount);
  } else if (sub === 'set') {
    newStock = amount;
  } else {
    newStock = 0;
  }
  if (newStock < 0) newStock = 0;

  const lastDepletedAt = newStock === 0 ? new Date() : null;

  await prisma.serverStock.update({
    where: { gameId_guildId: { gameId: game.id, guildId } },
    data: {
      stock: newStock,
      // /settokens (set) defines the refill target and starts a clean cycle —
      // the next gen begins a fresh 24h clock. add/remove/clear only nudge the
      // current count and leave the running cycle alone.
      ...(sub === 'set' ? { maxStock: newStock, cycleStartedAt: null } : {}),
      lastDepletedAt,
    },
  });

  await notifyStockRestocked(game.id, game.name, previousStock, newStock);

  if (newStock === 0) {
    await logGlobal('🚨 Game Depleted', `Stock for **${gameName}** has reached zero. Individual regeneration tracking active.`, 0xED4245);
    await logStockNotification(gameName, 'DEPLETED');
  } else if (newStock > 0 && newStock <= 3) {
    await logGlobal('⚠️ Low Stock Warning', `Stock for **${gameName}** is critically low (**${newStock}** remaining).`, 0xFEE75C);
  }

  return { ...game, stock: newStock, lastDepletedAt };
}

export async function updateStockForAllGames(amount: number, guildId: string = '') {
  const games = await prisma.game.findMany({ where: { disabled: false } });
  const depletedAt = amount === 0 ? new Date() : null;
  let notified = 0;

  for (const game of games) {
    const existing = await prisma.serverStock.findUnique({
      where: { gameId_guildId: { gameId: game.id, guildId } },
    });
    const previousStock = existing?.stock ?? 0;

    const stock = amount;
    const depletedAtRow = stock === 0 ? new Date() : null;
    // Bulk set defines the refill target too, and starts everyone on a clean
    // cycle (next gen begins a fresh 24h clock).
    await prisma.serverStock.upsert({
      where: { gameId_guildId: { gameId: game.id, guildId } },
      update: { stock, maxStock: stock, cycleStartedAt: null, lastDepletedAt: depletedAtRow },
      create: { gameId: game.id, guildId, stock, maxStock: stock, lastDepletedAt: depletedAtRow },
    });

    if (stock > previousStock) {
      await notifyStockRestocked(game.id, game.name, previousStock, stock);
      notified++;
    }
  }

  let restocksCleared = 0;
  if (amount === 0) {
    const result = await prisma.restock.deleteMany({ where: { guildId } });
    restocksCleared = result.count;
    await logGlobal('🚨 Bulk Depletion', `Stock for **all games** set to **0** (${games.length} game(s) updated).`, 0xED4245);
  } else {
    await prisma.restock.deleteMany({ where: { guildId } });
    await logGlobal('📦 Bulk Stock Set', `Stock for **all games** set to **${amount}** (${games.length} game(s) updated).`, 0x57F287);
  }

  return { count: games.length, restocksCleared, notified };
}

/**
 * Take one token off the panel. One path for every game — no account-quota
 * recomputation, no per-token Restock rows.
 *
 * The FIRST token of a cycle stamps cycleStartedAt, which is what the 24h
 * refill clock runs off. Later uses in the same cycle deliberately do NOT touch
 * it, so the refill time never drifts forward.
 */
export async function consumeStock(gameId: number, guildId: string, _fromQueue = false) {
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) throw new Error('Game not found.');

  const ss = await getOrCreateServerStock(gameId, guildId);
  const newStock = Math.max(0, ss.stock - 1);

  // excludeRegen games never auto-refill, so never start a cycle for them — a
  // countdown that will never fire would be a lie on the panel.
  const cycleStartedAt = game.excludeRegen ? ss.cycleStartedAt : (ss.cycleStartedAt ?? new Date());

  await prisma.serverStock.update({
    where: { gameId_guildId: { gameId, guildId } },
    data: {
      stock: newStock,
      cycleStartedAt,
      lastDepletedAt: newStock === 0 ? new Date() : null,
    },
  });

  if (newStock === 0) {
    await logGlobal('🚨 Game Depleted', `Stock for **${game.name}** has reached zero.`, 0xED4245);
    await logStockNotification(game.name, 'DEPLETED');
  } else if (newStock === 1) {
    await logGlobal('⚠️ Last Token Alert', `Only **1 token** remains for **${game.name}**.`, 0xFEE75C);
  } else {
    const thresholdSetting = await prisma.metadata.findUnique({ where: { key: 'lowStockThreshold' } });
    const threshold = thresholdSetting ? parseInt(thresholdSetting.value) : 3;
    if (newStock <= threshold) {
      await logGlobal('⚠️ Low Stock Warning', `**${game.name}** is running low — only **${newStock}** token(s) remaining.`, 0xFEE75C);
    }
  }

  return { ...game, stock: newStock };
}

/**
 * Consume one token FOR A TICKET, at most once ever.
 *
 * Every delivery path routes through here (auto-gen, EA/Ubisoft mint, installer
 * call-home, staff zip, close-with-deduct), so a ticket can only cost one token
 * no matter how many of those fire. The claim is a conditional UPDATE, so two
 * concurrent paths can't both win.
 *
 * Returns true if this call is the one that took the token.
 */
export async function consumeStockForTicket(
  ticket: { id: number; gameId: number; fromQueue?: boolean | null },
  guildId: string,
): Promise<boolean> {
  const claim = await prisma.ticket.updateMany({
    where: { id: ticket.id, stockConsumed: false },
    data: { stockConsumed: true },
  });
  if (claim.count === 0) return false; // another path already paid for this ticket

  try {
    await consumeStock(ticket.gameId, guildId, !!ticket.fromQueue);
    return true;
  } catch (e) {
    // Release the claim so a transient failure doesn't silently eat the token.
    await prisma.ticket
      .updateMany({ where: { id: ticket.id }, data: { stockConsumed: false } })
      .catch(() => {});
    throw e;
  }
}

/** Staff manually delivered a zip without autogen — decrement panel stock by 1. */
export async function manualConsumeStock(gameId: number, guildId: string) {
  return consumeStock(gameId, guildId);
}

export async function purgeGameCascade(gameId: number) {
  await prisma.pendingVerification.deleteMany({
    where: { ticket: { gameId } },
  });
  await prisma.ticket.deleteMany({ where: { gameId } });
  await prisma.restock.deleteMany({ where: { gameId } });
  await prisma.subscription.deleteMany({ where: { gameId } });
  await prisma.waitlist.deleteMany({ where: { gameId } });
  await prisma.serverStock.deleteMany({ where: { gameId } });
  await prisma.game.delete({ where: { id: gameId } });
}
