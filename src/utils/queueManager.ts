import { GuildMember } from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { isStaffForGuild, getTierForGuild } from './permissions';

export const QUEUE_RESERVE_RATIO = CONFIG.QUEUE_RESERVE_RATIO;

/** Split total stock: e.g. 10 tokens → 7 general + 3 queue (70/30). */
export function computeSlotSplit(totalStock: number): { generalCapacity: number; queueCapacity: number } {
  const queueCapacity = Math.round(totalStock * QUEUE_RESERVE_RATIO);
  const generalCapacity = Math.max(0, totalStock - queueCapacity);
  return { generalCapacity, queueCapacity };
}

export async function getQueueSize(gameId: number): Promise<number> {
  return prisma.waitlist.count({ where: { gameId } });
}

export async function getQueuePosition(userId: string, gameId: number): Promise<number | null> {
  const entry = await prisma.waitlist.findUnique({
    where: { userId_gameId: { userId, gameId } },
  });
  if (!entry) return null;
  return prisma.waitlist.count({
    where: { gameId, createdAt: { lte: entry.createdAt } },
  });
}

export async function getSlotUsage(
  gameId: number,
  guildId: string,
): Promise<{ generalUsed: number; queueUsed: number }> {
  const open = await prisma.ticket.findMany({
    where: { gameId, guildId, status: { in: ['OPEN', 'CLAIMED'] } },
    select: { fromQueue: true },
  });
  return {
    generalUsed: open.filter((t) => !t.fromQueue).length,
    queueUsed: open.filter((t) => t.fromQueue).length,
  };
}

/** Only Gold tier members and staff may skip queue pool limits. */
export async function canBypassQueue(member: GuildMember, guildId: string): Promise<boolean> {
  if (await isStaffForGuild(member, guildId)) return true;
  const tier = await getTierForGuild(member, guildId);
  return tier === 'Gold';
}

export type QueueAccessResult =
  | { allowed: true; fromQueue: boolean }
  | { allowed: false; error: string };

async function isEligibleForQueueSlot(
  userId: string,
  gameId: number,
  queueCapacity: number,
  queueUsed: number,
): Promise<boolean> {
  if (queueCapacity <= 0 || queueUsed >= queueCapacity) return false;

  const entry = await prisma.waitlist.findUnique({
    where: { userId_gameId: { userId, gameId } },
  });
  if (!entry) return false;

  const aheadOnWaitlist = await prisma.waitlist.count({
    where: { gameId, createdAt: { lt: entry.createdAt } },
  });
  const queueRemaining = queueCapacity - queueUsed;
  return aheadOnWaitlist < queueRemaining;
}

/**
 * When a queue is active, total stock is split ~70% general / ~30% FIFO queue.
 * Queue users may also use general slots. Non-queue users cannot use queue slots.
 */
export async function checkQueueAccess(
  userId: string,
  gameId: number,
  gameName: string,
  totalStock: number,
  availableResources: number,
  guildId: string,
  canBypass: boolean,
): Promise<QueueAccessResult> {
  if (availableResources <= 0) {
    return { allowed: false, error: '❌ **Out of Stock.**' };
  }

  const queueSize = await getQueueSize(gameId);
  if (queueSize === 0) return { allowed: true, fromQueue: false };
  if (canBypass) return { allowed: true, fromQueue: false };

  const { generalCapacity, queueCapacity } = computeSlotSplit(totalStock);
  const { generalUsed, queueUsed } = await getSlotUsage(gameId, guildId);
  const generalRemaining = generalCapacity - generalUsed;
  const queueRemaining = queueCapacity - queueUsed;

  if (generalRemaining > 0) {
    return { allowed: true, fromQueue: false };
  }

  const queueEligible = await isEligibleForQueueSlot(userId, gameId, queueCapacity, queueUsed);
  if (queueEligible && queueRemaining > 0) {
    return { allowed: true, fromQueue: true };
  }

  const position = await getQueuePosition(userId, gameId);
  const generalPct = Math.round((1 - QUEUE_RESERVE_RATIO) * 100);
  const queuePct = Math.round(QUEUE_RESERVE_RATIO * 100);

  if (position !== null) {
    return {
      allowed: false,
      error:
        `⏳ **Queue Position #${position}** for **${gameName}**.\n\n` +
        `**${generalPct}%** of total stock (${Math.max(0, generalRemaining)}/${generalCapacity} general left) — currently full.\n` +
        `**${queuePct}%** (${Math.max(0, queueRemaining)}/${queueCapacity} queue left) — reserved FIFO.\n\n` +
        `Wait for a general slot to free up, or for your queue turn. **Gold** / **Staff** can bypass.`,
    };
  }

  return {
    allowed: false,
    error:
      `⏳ **Queue Active** for **${gameName}** — **${queueSize}** waiting.\n\n` +
      `**${generalPct}%** of total stock (${Math.max(0, generalRemaining)}/${generalCapacity} general left) — currently full.\n` +
      `**${queuePct}%** (${Math.max(0, queueRemaining)}/${queueCapacity} queue left) — reserved FIFO. Join when out of stock, ` +
      `or upgrade to **Gold** to bypass.`,
  };
}

export async function removeFromQueue(userId: string, gameId: number): Promise<void> {
  await prisma.waitlist.deleteMany({ where: { userId, gameId } });
}

/** How many queue users to notify when stock increases. */
export function queueNotifyCount(previousStock: number, newStock: number): number {
  const prev = computeSlotSplit(previousStock).queueCapacity;
  const next = computeSlotSplit(newStock).queueCapacity;
  return Math.max(0, next - prev);
}

export interface GameQueueSummary {
  gameId: number;
  gameName: string;
  queueSize: number;
  stock: number;
  reserved: number;
  available: number;
  generalCapacity: number;
  queueCapacity: number;
  generalUsed: number;
  queueUsed: number;
  userPosition: number | null;
}

export async function getAllGameQueues(guildId: string, userId?: string): Promise<GameQueueSummary[]> {
  const games = await prisma.game.findMany({
    where: { disabled: false },
    orderBy: { name: 'asc' },
  });

  const waitlistCounts = await prisma.waitlist.groupBy({
    by: ['gameId'],
    _count: true,
  });
  const waitlistMap = new Map(waitlistCounts.map((w) => [w.gameId, w._count]));

  const openTickets = await prisma.ticket.findMany({
    where: { guildId, status: { in: ['OPEN', 'CLAIMED'] } },
    select: { gameId: true, fromQueue: true },
  });
  const reservedMap = new Map<number, number>();
  const generalUsedMap = new Map<number, number>();
  const queueUsedMap = new Map<number, number>();
  for (const t of openTickets) {
    reservedMap.set(t.gameId, (reservedMap.get(t.gameId) || 0) + 1);
    if (t.fromQueue) {
      queueUsedMap.set(t.gameId, (queueUsedMap.get(t.gameId) || 0) + 1);
    } else {
      generalUsedMap.set(t.gameId, (generalUsedMap.get(t.gameId) || 0) + 1);
    }
  }

  const stocks = await prisma.serverStock.findMany({ where: { guildId } });
  const stockMap = new Map(stocks.map((s) => [s.gameId, s.stock]));

  const userEntries = userId
    ? await prisma.waitlist.findMany({ where: { userId }, select: { gameId: true, createdAt: true } })
    : [];
  const userEntryMap = new Map(userEntries.map((e) => [e.gameId, e.createdAt]));

  const summaries: GameQueueSummary[] = [];

  for (const game of games) {
    const queueSize = waitlistMap.get(game.id) || 0;
    const stock = stockMap.get(game.id) ?? 5;
    const reserved = reservedMap.get(game.id) || 0;
    const available = Math.max(0, stock - reserved);
    const { generalCapacity, queueCapacity } = computeSlotSplit(stock);
    const generalUsed = generalUsedMap.get(game.id) || 0;
    const queueUsed = queueUsedMap.get(game.id) || 0;

    let userPosition: number | null = null;
    const joinedAt = userEntryMap.get(game.id);
    if (joinedAt) {
      userPosition = await prisma.waitlist.count({
        where: { gameId: game.id, createdAt: { lte: joinedAt } },
      });
    }

    if (queueSize > 0 || userPosition !== null) {
      summaries.push({
        gameId: game.id,
        gameName: game.name,
        queueSize,
        stock,
        reserved,
        available,
        generalCapacity,
        queueCapacity,
        generalUsed,
        queueUsed,
        userPosition,
      });
    }
  }

  return summaries;
}

export interface QueueRosterEntry {
  position: number;
  userId: string;
  joinedAt: Date;
}

export interface GameQueueRoster {
  gameId: number;
  gameName: string;
  entries: QueueRosterEntry[];
}

/** Full FIFO roster for one game or all games with active queues. */
export async function getQueueRoster(gameName?: string | null): Promise<GameQueueRoster[]> {
  let gameId: number | undefined;
  if (gameName) {
    const game = await prisma.game.findUnique({ where: { name: gameName } });
    if (!game) return [];
    gameId = game.id;
  }

  const entries = await prisma.waitlist.findMany({
    where: gameId !== undefined ? { gameId } : undefined,
    include: { game: true },
    orderBy: [{ gameId: 'asc' }, { createdAt: 'asc' }],
  });

  const byGame = new Map<number, GameQueueRoster>();
  for (const entry of entries) {
    let roster = byGame.get(entry.gameId);
    if (!roster) {
      roster = { gameId: entry.gameId, gameName: entry.game.name, entries: [] };
      byGame.set(entry.gameId, roster);
    }
    roster.entries.push({
      position: roster.entries.length + 1,
      userId: entry.userId,
      joinedAt: entry.createdAt,
    });
  }

  return [...byGame.values()].sort((a, b) => a.gameName.localeCompare(b.gameName));
}
