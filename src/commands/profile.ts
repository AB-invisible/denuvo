import { GuildMember } from 'discord.js';
import prisma from '../lib/prisma';
import { getUserSubscriptions } from '../utils/subscriptionManager';
import { createProfileEmbed } from '../utils/embeds';
import { getTrustScore } from '../utils/trustScore';

export async function execute(interaction: any): Promise<void> {
  const cooldown = await prisma.cooldown.findUnique({ where: { userId: interaction.user.id } });
  const subs = await getUserSubscriptions(interaction.user.id);
  const total = await prisma.ticket.count({ where: { userId: interaction.user.id, status: 'CLOSED' } });
  const trustInfo = await getTrustScore(interaction.user.id);
  await interaction.editReply({ embeds: [createProfileEmbed(interaction.user, cooldown, subs, total, interaction.member as GuildMember, trustInfo)] });
}
