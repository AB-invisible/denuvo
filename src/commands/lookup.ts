import prisma from '../lib/prisma';
import { createStaffLookupEmbed } from '../utils/embeds';

export async function execute(interaction: any): Promise<void> {
  const target = interaction.options.getUser('user')!;
  const cooldown = await prisma.cooldown.findUnique({ where: { userId: target.id } });
  const history = await prisma.ticket.findMany({ where: { userId: target.id }, take: 5, orderBy: { createdAt: 'desc' } });
  await interaction.editReply({ embeds: [createStaffLookupEmbed(target, history, cooldown)] });
}
