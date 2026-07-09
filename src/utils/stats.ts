import prisma from '../lib/prisma';

export interface StaffStat {
  staffId: string;
  _count: {
    id: number;
  };
}

export async function getEstimatedWaitTime(guildId?: string): Promise<string> {
  try {
    const windowStart = new Date();
    windowStart.setHours(windowStart.getHours() - 6);

    // Scope to one server when a guildId is given so a tenant sees ITS OWN
    // queue, not the global cross-tenant total. Omit → global (back-compat).
    const guildScope = guildId ? { guildId } : {};

    const data = await prisma.ticket.findMany({
      where: {
        ...guildScope,
        status: 'CLOSED',
        claimedAt: { not: null },
        closedAt: { not: null },
        createdAt: { gte: windowStart }
      },
      orderBy: { createdAt: 'desc' },
      take: 25
    });

    const openCount = await prisma.ticket.count({
      where: { ...guildScope, status: 'OPEN' }
    });

    if (data.length === 0) {
      if (openCount === 0) return 'Immediate';
      return `~${(openCount + 1) * 10} Minutes`;
    }

    // 1. Avg Response Time (Claim - Created)
    const claimTimes = data.map(t => (t.claimedAt as Date).getTime() - t.createdAt.getTime());
    const avgClaimDelay = claimTimes.reduce((a, b) => a + b, 0) / claimTimes.length;

    // 2. Avg Resolution Time (Closed - Claimed)
    const processingTimes = data.map(t => (t.closedAt as Date).getTime() - (t.claimedAt as Date).getTime());
    const avgProcessingTime = processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length;

    // 3. Active Staff (Throughput)
    // Count distinct staff who claimed a ticket in the last 2 hours
    const slice = new Date();
    slice.setHours(slice.getHours() - 2);
    const activeStaffSet = new Set(data.filter(t => t.claimedAt && t.claimedAt > slice).map(t => t.staffId));
    const throughputFactor = Math.max(1, activeStaffSet.size);

    /**
     * Logic:
     * - Queue Delay = (Open Tickets / Active Staff) * Avg Response Delay
     * - Resolution = + Avg Processing Time
     */
    const queueDelay = (openCount / throughputFactor) * avgClaimDelay;
    const estimatedTotalMs = queueDelay + avgProcessingTime;
    
    const minutes = Math.ceil(estimatedTotalMs / (1000 * 60));

    if (minutes <= 2) return '🚀 **Instant** (1-2m)';
    if (minutes <= 5) return '⚡ **Fast** (3-5m)';
    if (minutes <= 10) return '🟢 **Normal** (5-10m)';
    if (minutes <= 20) return '🟡 **Moderate** (10-20m)';
    if (minutes <= 45) return '🔴 **High Traffic** (30-45m)';
    return `⌛ **Busy** (${Math.floor(minutes / 60)}h ${minutes % 60}m)`;
  } catch (err) {
    console.error('Wait time calculation failure:', err);
    return '15-20 Minutes';
  }
}

export async function getStaffStats(guildId?: string): Promise<StaffStat[]> {
  try {
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    // Bug #19 fix: Only count CLOSED tickets, not still-open or abandoned ones
    const stats = await prisma.ticket.groupBy({
      by: ['staffId'],
      where: {
        ...(guildId ? { guildId } : {}),
        staffId: { not: null },
        status: 'CLOSED',
        claimedAt: { gte: oneWeekAgo }
      },
      _count: {
        id: true
      },
      orderBy: {
        _count: {
          id: 'desc'
        }
      }
    });

    return stats as unknown as StaffStat[];
  } catch (err) {
    console.error('Error getting staff stats:', err);
    return [];
  }
}
