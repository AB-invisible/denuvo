import prisma from '../lib/prisma';

/** In-memory set of channel IDs with OPEN/CLAIMED tickets — avoids a DB round-trip on every guild message. */
const activeTicketChannels = new Set<string>();

export function isActiveTicketChannel(channelId: string): boolean {
  return activeTicketChannels.has(channelId);
}

export function trackTicketChannel(channelId: string): void {
  activeTicketChannels.add(channelId);
}

export function untrackTicketChannel(channelId: string): void {
  activeTicketChannels.delete(channelId);
}

export async function hydrateActiveTicketChannels(): Promise<void> {
  const tickets = await prisma.ticket.findMany({
    where: { status: { in: ['OPEN', 'CLAIMED'] } },
    select: { channelId: true },
  });
  activeTicketChannels.clear();
  for (const t of tickets) activeTicketChannels.add(t.channelId);
  console.log(`[TicketCache] Tracking ${activeTicketChannels.size} active ticket channel(s).`);
}
