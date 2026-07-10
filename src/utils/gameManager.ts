import prisma from '../lib/prisma';
import { Game, Prisma, ServerStock } from '@prisma/client';
import { logGlobal, logStockNotification } from './logging';
import { notifySubscribers } from './subscriptionManager';
import { notifyWaitlist } from './waitlistManager';
import { getAllowedGuildIds } from './tenant';
import { CONFIG } from '../config';

export const REGEN_TIME = 24 * 60 * 60 * 1000; // 24 hours

export async function getOrCreateServerStock(gameId: number, guildId: string): Promise<ServerStock> {
  const existing = await prisma.serverStock.findUnique({
    where: { gameId_guildId: { gameId, guildId } },
  });
  if (existing) return existing;
  return prisma.serverStock.create({
    data: { gameId, guildId, stock: 5 },
  });
}

export async function getServerStockMapForGuild(
  guildId: string,
): Promise<Map<number, { stock: number; lastDepletedAt: Date | null }>> {
  const stocks = await prisma.serverStock.findMany({ where: { guildId } });
  return new Map(stocks.map((s) => [s.gameId, { stock: s.stock, lastDepletedAt: s.lastDepletedAt }]));
}

export async function processGuildRestocks(guildId: string): Promise<void> {
  const now = new Date();
  const pendingRestocks = await prisma.restock.findMany({
    where: { guildId, restockAt: { lte: now } },
    include: { game: true },
  });
  if (pendingRestocks.length === 0) return;

  const byGame = new Map<number, typeof pendingRestocks>();
  for (const r of pendingRestocks) {
    if (r.game.excludeRegen) continue;
    if (!byGame.has(r.gameId)) byGame.set(r.gameId, []);
    byGame.get(r.gameId)!.push(r);
  }

  for (const [gameId, restocks] of byGame) {
    const amount = restocks.length;
    const serverStock = await getOrCreateServerStock(gameId, guildId);

    await prisma.$transaction([
      prisma.serverStock.update({
        where: { gameId_guildId: { gameId, guildId } },
        data: { stock: serverStock.stock + amount, lastDepletedAt: null },
      }),
      prisma.restock.deleteMany({
        where: { id: { in: restocks.map(r => r.id) } },
      }),
    ]);

    const gameName = restocks[0].game.name;
    await logGlobal('✅ Auto-Restock', `**${amount} token(s)** auto-restocked for **${gameName}**.`, 0x57F287);
    await notifySubscribers(gameId, gameName, amount);
    await notifyWaitlist(gameId, gameName, amount);
  }
}

export async function initServerStocksForGame(gameId: number): Promise<void> {
  const guildIds = await getAllowedGuildIds();
  for (const guildId of guildIds) {
    await prisma.serverStock.upsert({
      where: { gameId_guildId: { gameId, guildId } },
      update: {},
      create: { gameId, guildId, stock: 5 },
    });
  }
}

export async function getActiveGames() {
  return prisma.game.findMany({
    where: { disabled: false },
    include: {
      _count: {
        select: {
          tickets: {
            where: { status: { in: ['OPEN', 'CLAIMED'] } },
          },
        },
      },
    },
    orderBy: { name: 'asc' },
  });
}

export async function getGameByName(name: string) {
  return prisma.game.findUnique({
    where: { name, disabled: false },
  });
}

export async function updateStock(gameName: string, sub: 'add' | 'remove' | 'set' | 'clear', amount: number = 0, guildId: string = '') {
  const game = await prisma.game.findUnique({ where: { name: gameName } });
  if (!game) throw new Error(`Game "${gameName}" not found.`);

  const serverStock = await getOrCreateServerStock(game.id, guildId);

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
    data: { stock: newStock, lastDepletedAt },
  });

  if (sub === 'add' || (sub === 'set' && amount > 0)) {
    await notifySubscribers(game.id, game.name, amount);
    await notifyWaitlist(game.id, game.name, amount);
  }

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

  for (const game of games) {
    await prisma.serverStock.upsert({
      where: { gameId_guildId: { gameId: game.id, guildId } },
      update: { stock: amount, lastDepletedAt: depletedAt },
      create: { gameId: game.id, guildId, stock: amount, lastDepletedAt: depletedAt },
    });
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

  return { count: games.length, restocksCleared };
}

export async function consumeStock(gameId: number, guildId: string) {
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) throw new Error('Game not found.');

  await processGuildRestocks(guildId);
  const restockAt = new Date(Date.now() + REGEN_TIME);

  const updatedStock = await prisma.$transaction(async (tx) => {
    const ss = await tx.serverStock.findUnique({
      where: { gameId_guildId: { gameId, guildId } },
    });
    const currentStock = ss?.stock ?? 5;
    const finalStock = Math.max(0, currentStock - 1);

    const updated = await tx.serverStock.upsert({
      where: { gameId_guildId: { gameId, guildId } },
      update: {
        stock: finalStock,
        lastDepletedAt: finalStock === 0 ? new Date() : null,
      },
      create: {
        gameId,
        guildId,
        stock: finalStock,
        lastDepletedAt: finalStock === 0 ? new Date() : null,
      },
    });

    if (!game.excludeRegen) {
      await tx.restock.create({
        data: { gameId, guildId, restockAt },
      });
    }

    return updated;
  });

  if (updatedStock.stock === 0) {
    await logGlobal('🚨 Game Depleted', `Stock for **${game.name}** has reached zero via consumption. Individual regeneration tracking active.`, 0xED4245);
  } else if (updatedStock.stock === 1) {
    await logGlobal('⚠️ Last Token Alert', `Only **1 token** remains for **${game.name}**.`, 0xFEE75C);
  }

  if (updatedStock.stock > 0) {
    const thresholdSetting = await prisma.metadata.findUnique({ where: { key: 'lowStockThreshold' } });
    const threshold = thresholdSetting ? parseInt(thresholdSetting.value) : 3;
    if (updatedStock.stock <= threshold) {
      await logGlobal('⚠️ Low Stock Warning', `**${game.name}** is running low — only **${updatedStock.stock}** token(s) remaining.`, 0xFEE75C);
    }
  }

  return { ...game, stock: updatedStock.stock };
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
