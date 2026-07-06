import prisma from '../lib/prisma';

export async function execute(interaction: any): Promise<void> {
  const name = interaction.options.getString('name')!.trim();

  if (name.length < 2 || name.length > 100) {
    return interaction.editReply({ content: '❌ Game name must be between 2 and 100 characters.' });
  }

  const existing = await prisma.game.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
  });
  if (existing) {
    return interaction.editReply({
      content: `ℹ️ **${existing.name}** is already in the catalog! ${existing.disabled ? '(Currently hidden — check back later.)' : 'Select it from the panel to open a ticket.'}`,
    });
  }

  const normalizedName = name.toLowerCase();

  const alreadyVoted = await prisma.gameRequest.findFirst({
    where: { userId: interaction.user.id, gameName: { equals: normalizedName, mode: 'insensitive' } },
  });

  if (alreadyVoted) {
    const voteCount = await prisma.gameRequest.count({
      where: { gameName: { equals: normalizedName, mode: 'insensitive' } },
    });
    return interaction.editReply({
      content: `ℹ️ You already voted for **${name}**. Current votes: **${voteCount}** 🗳️`,
    });
  }

  await prisma.gameRequest.create({
    data: { userId: interaction.user.id, gameName: name },
  });

  const voteCount = await prisma.gameRequest.count({
    where: { gameName: { equals: normalizedName, mode: 'insensitive' } },
  });

  await interaction.editReply({
    content: `✅ **Vote Recorded!** You voted for **${name}** to be added.\nTotal votes: **${voteCount}** 🗳️`,
  });
}
