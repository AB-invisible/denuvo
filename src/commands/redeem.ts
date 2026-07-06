import prisma from '../lib/prisma';
import { logAction } from '../utils/logging';

export async function execute(interaction: any): Promise<void> {
  const code = interaction.options.getString('code')!.trim().toUpperCase();

  const promo = await prisma.promoCode.findUnique({ where: { code } });
  if (!promo) {
    return interaction.editReply({ content: '❌ Invalid promo code.' });
  }

  if (promo.expiresAt && promo.expiresAt <= new Date()) {
    return interaction.editReply({ content: '❌ This promo code has expired.' });
  }

  if (promo.usedCount >= promo.maxUses) {
    return interaction.editReply({ content: '❌ This promo code has reached its maximum uses.' });
  }

  const alreadyRedeemed = await prisma.promoRedemption.findUnique({
    where: { userId_promoId_guildId: { userId: interaction.user.id, promoId: promo.id, guildId: interaction.guildId || '' } },
  });
  if (alreadyRedeemed) {
    return interaction.editReply({ content: '❌ You have already redeemed this promo code.' });
  }

  if (promo.effect === 'cooldown_reset') {
    await prisma.cooldown.deleteMany({ where: { userId: interaction.user.id, guildId: interaction.guildId || '' } });

    await prisma.promoRedemption.create({
      data: { userId: interaction.user.id, promoId: promo.id, guildId: interaction.guildId || '' },
    });
    await prisma.promoCode.update({
      where: { id: promo.id },
      data: { usedCount: { increment: 1 } },
    });

    await interaction.editReply({
      content: '✅ **Promo Redeemed!** Your cooldown has been reset. You can open a new ticket now.',
    });
  } else if (promo.effect === 'temp_tier') {
    const expiresAt = new Date(Date.now() + (promo.durationH || 24) * 60 * 60 * 1000);

    await prisma.promoRedemption.create({
      data: { userId: interaction.user.id, promoId: promo.id, guildId: interaction.guildId || '', expiresAt },
    });
    await prisma.promoCode.update({
      where: { id: promo.id },
      data: { usedCount: { increment: 1 } },
    });

    await interaction.editReply({
      content: `✅ **Promo Redeemed!** You now have **${promo.tierGrant}** tier for **${promo.durationH}h**.\n⏱️ Expires <t:${Math.floor(expiresAt.getTime() / 1000)}:R>\n\nYour next ticket close will use ${promo.tierGrant}-tier cooldown instead of your normal tier.`,
    });
  }

  if (interaction.guild) {
    const effectDesc = promo.effect === 'cooldown_reset'
      ? 'Cooldown Reset'
      : `Temp ${promo.tierGrant} for ${promo.durationH}h`;
    await logAction(interaction.guild, '🎟️ Promo Redeemed',
      `User ${interaction.user} redeemed promo \`${code}\` (${effectDesc}). Uses: ${promo.usedCount + 1}/${promo.maxUses}.`, 0x57F287);
  }
}
