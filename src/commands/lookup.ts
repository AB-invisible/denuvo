import prisma from '../lib/prisma';
import { createStaffLookupEmbed } from '../utils/embeds';
import { getBlacklistEntry } from '../utils/blacklistManager';

export async function execute(interaction: any): Promise<void> {
  const target = interaction.options.getUser('user')!;
  const guildId = interaction.guildId || '';
  const [cooldown, history, blacklist] = await Promise.all([
    prisma.cooldown.findUnique({ where: { userId_guildId: { userId: target.id, guildId } } }),
    prisma.ticket.findMany({ where: { userId: target.id, guildId }, take: 5, orderBy: { createdAt: 'desc' } }),
    getBlacklistEntry(target.id, guildId),
  ]);
  await interaction.editReply({ embeds: [createStaffLookupEmbed(target, history, cooldown, blacklist)] });
}
