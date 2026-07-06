import prisma from '../lib/prisma';

export async function execute(interaction: any): Promise<void> {
  const user = interaction.options.getUser('user')!;
  await prisma.cooldown.deleteMany({ where: { userId: user.id, guildId: interaction.guildId || '' } });
  await prisma.ticket.updateMany({
    where: { userId: user.id, guildId: interaction.guildId, status: 'CLOSED', screenshotVerified: false },
    data: { screenshotVerified: true }
  });
  await interaction.editReply({ content: `✅ **Restriction Lifted:** Cooldown cleared and strikes reset for ${user} in this server.` });
}
