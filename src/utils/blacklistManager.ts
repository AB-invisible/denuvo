import prisma from '../lib/prisma';

export async function isUserBlacklisted(userId: string, guildId: string): Promise<boolean> {
  const row = await prisma.denuvoBlacklist.findUnique({
    where: { userId_guildId: { userId, guildId } },
  });
  return !!row;
}

export async function getBlacklistEntry(userId: string, guildId: string) {
  return prisma.denuvoBlacklist.findUnique({
    where: { userId_guildId: { userId, guildId } },
  });
}

export async function addToBlacklist(
  userId: string,
  guildId: string,
  staffId: string,
  reason?: string | null,
): Promise<{ created: boolean }> {
  const existing = await getBlacklistEntry(userId, guildId);
  if (existing) {
    await prisma.denuvoBlacklist.update({
      where: { userId_guildId: { userId, guildId } },
      data: {
        reason: reason?.trim() || existing.reason,
        staffId,
      },
    });
    return { created: false };
  }

  await prisma.denuvoBlacklist.create({
    data: {
      userId,
      guildId,
      staffId,
      reason: reason?.trim() || null,
    },
  });
  return { created: true };
}

export async function removeFromBlacklist(userId: string, guildId: string): Promise<boolean> {
  const result = await prisma.denuvoBlacklist.deleteMany({
    where: { userId, guildId },
  });
  return result.count > 0;
}

export const BLACKLIST_TICKET_MESSAGE =
  '🚫 **Blacklisted:** You are permanently banned from opening **Denuvo activation tickets** on this server. Contact staff if you believe this is a mistake.';
