import prisma from '../lib/prisma';

export interface TrustInfo {
  score: number;
  successes: number;
  failures: number;
  rank: string;
}

const TRUST_RANKS: { min: number; label: string }[] = [
  { min: 50, label: '⭐ Trusted' },
  { min: 20, label: '🟢 Regular' },
  { min: 0, label: '🔵 New' },
  { min: -Infinity, label: '🔴 Flagged' },
];

export async function getTrustScore(userId: string, guildId?: string): Promise<TrustInfo> {
  const guildFilter = guildId ? { guildId } : {};
  const [successes, failures] = await Promise.all([
    prisma.ticket.count({ where: { userId, ...guildFilter, status: 'CLOSED', screenshotVerified: true } }),
    prisma.ticket.count({ where: { userId, ...guildFilter, status: 'CLOSED', screenshotVerified: false } }),
  ]);

  const score = (successes * 10) + (failures * -20);
  const rank = TRUST_RANKS.find(r => score >= r.min)?.label || '🔵 New';

  return { score, successes, failures, rank };
}
