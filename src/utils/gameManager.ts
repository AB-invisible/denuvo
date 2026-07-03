import prisma from '../lib/prisma';
import { Game, Prisma } from '@prisma/client';
import { logGlobal, logStockNotification } from './logging';
import { notifySubscribers } from './subscriptionManager';

export const REGEN_TIME = 24 * 60 * 60 * 1000; // 24 hours

export async function checkRegeneration(game: Game): Promise<Game> {
  // Skip regeneration entirely for excluded games
  if (game.excludeRegen) return game;

  const now = new Date();
  
  // Find all pending restocks for this game that are due
  const pendingRestocks = await prisma.restock.findMany({
    where: {
      gameId: game.id,
      restockAt: { lte: now }
    }
  });

  if (pendingRestocks.length > 0) {
    const amountToRestock = pendingRestocks.length;
    
    // Atomic update: increment stock and delete processed restock records
    const [updatedGame] = await prisma.$transaction([
      prisma.game.update({
        where: { id: game.id },
        data: { stock: { increment: amountToRestock }, lastDepletedAt: null }
      }),
      prisma.restock.deleteMany({
        where: {
          id: { in: pendingRestocks.map((r) => r.id) }
        }
      })
    ]);

    await logStockNotification(game.name, 'RESTOCKED', amountToRestock);
    await notifySubscribers(game.id, game.name, amountToRestock);
    return updatedGame;
  }

  return game;
}

export async function getActiveGames() {
  const games = await prisma.game.findMany({
    where: { disabled: false },
    orderBy: { name: 'asc' },
  });

  await Promise.all(games.map((game: Game) => checkRegeneration(game)));

  return await prisma.game.findMany({
    where: { disabled: false },
    include: {
      _count: {
        select: {
          tickets: {
            where: {
              status: { in: ['OPEN', 'CLAIMED'] }
            }
          }
        }
      }
    },
    orderBy: { name: 'asc' },
  });
}

export async function getGameByName(name: string) {
  const game = await prisma.game.findUnique({
    where: { name, disabled: false },
  });
  if (!game) return null;
  return await checkRegeneration(game);
}

export async function updateStock(gameName: string, sub: 'add' | 'remove' | 'set' | 'clear', amount: number = 0) {
  let updateData: Prisma.GameUpdateInput = {};
  
  if (sub === 'add') {
    updateData = { stock: { increment: amount }, lastDepletedAt: null };
  } else if (sub === 'remove') {
    updateData = { stock: { decrement: amount } };
  } else if (sub === 'set') {
    updateData = { stock: amount, lastDepletedAt: amount > 0 ? null : new Date() };
  } else if (sub === 'clear') {
    updateData = { stock: 0, lastDepletedAt: new Date() };
  }

  const updatedGame = await prisma.game.update({
    where: { name: gameName },
    data: updateData
  });

  // Post-update: Ensure stock isn't negative
  if (updatedGame.stock < 0) {
    await prisma.game.update({ where: { id: updatedGame.id }, data: { stock: 0, lastDepletedAt: new Date() } });
    updatedGame.stock = 0;
  }

  if (sub === 'add' || (sub === 'set' && amount > 0)) {
    const amountAdded = sub === 'add' ? amount : amount; // Simplified for notification logic
    await notifySubscribers(updatedGame.id, updatedGame.name, amountAdded);
  }

  if (updatedGame.stock === 0) {
    await logGlobal('🚨 Game Depleted', `Stock for **${gameName}** has reached zero. Individual regeneration tracking active.`, 0xED4245);
    await logStockNotification(gameName, 'DEPLETED');
  } else if (updatedGame.stock > 0 && updatedGame.stock <= 3) {
    await logGlobal('⚠️ Low Stock Warning', `Stock for **${gameName}** is critically low (**${updatedGame.stock}** remaining).`, 0xFEE75C);
  }

  return updatedGame;
}

export async function consumeStock(gameId: number) {
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) throw new Error('Game not found.');

  // Always check/run regeneration first
  const currentStock = (await checkRegeneration(game)).stock;
  const restockAt = new Date(Date.now() + REGEN_TIME);

  // Atomic: handle consumption and restock scheduling
  const updatedGame = await prisma.$transaction(async (tx) => {
    const freshGame = await tx.game.findUnique({ where: { id: gameId } });
    if (!freshGame) throw new Error('Game not found.');

    // Only decrement if we actually have stock
    // If stock is 0, we treat it as "consumed" but it stays 0 while queuing the restock
    const finalStock = Math.max(0, freshGame.stock - 1);

    const updated = await tx.game.update({
      where: { id: gameId },
      data: { 
        stock: finalStock,
        lastDepletedAt: finalStock === 0 ? new Date() : undefined
      },
    });

    // Only schedule auto-restock if the game is not excluded from regeneration
    if (!freshGame.excludeRegen) {
      await tx.restock.create({
        data: {
          gameId,
          restockAt
        }
      });
    }

    return updated;
  });

  if (updatedGame.stock === 0) {
    await logGlobal('🚨 Game Depleted', `Stock for **${updatedGame.name}** has reached zero via consumption. Individual regeneration tracking active.`, 0xED4245);
    await logStockNotification(updatedGame.name, 'DEPLETED');
  } else if (updatedGame.stock === 1) {
    await logGlobal('⚠️ Last Token Alert', `Only **1 token** remains for **${updatedGame.name}**.`, 0xFEE75C);
  }

  return updatedGame;
}
