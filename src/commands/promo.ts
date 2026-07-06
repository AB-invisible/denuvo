import { EmbedBuilder } from 'discord.js';
import prisma from '../lib/prisma';
import { logAction } from '../utils/logging';

export async function execute(interaction: any): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === 'create') {
    const code = interaction.options.getString('code')!.trim().toUpperCase();
    const effect = interaction.options.getString('effect')!;
    const tierGrant = interaction.options.getString('tier') || null;
    const durationH = interaction.options.getInteger('duration_hours') || null;
    const maxUses = interaction.options.getInteger('max_uses') ?? 1;
    const expiresInH = interaction.options.getInteger('expires_in_hours') || null;

    if (effect === 'temp_tier' && !tierGrant) {
      return interaction.editReply({ content: '❌ You must specify a `tier` for temporary tier promos.' });
    }
    if (effect === 'temp_tier' && !durationH) {
      return interaction.editReply({ content: '❌ You must specify `duration_hours` for temporary tier promos.' });
    }

    const existing = await prisma.promoCode.findUnique({ where: { code } });
    if (existing) {
      return interaction.editReply({ content: `❌ Promo code **${code}** already exists.` });
    }

    const expiresAt = expiresInH ? new Date(Date.now() + expiresInH * 60 * 60 * 1000) : null;

    await prisma.promoCode.create({
      data: { code, effect, tierGrant, durationH, maxUses, expiresAt },
    });

    const effectDesc = effect === 'cooldown_reset'
      ? 'Cooldown Reset'
      : `Temp ${tierGrant} for ${durationH}h`;

    await interaction.editReply({
      content: `✅ **Promo Created:** \`${code}\`\n• Effect: **${effectDesc}**\n• Max Uses: **${maxUses}**\n• Expires: ${expiresAt ? `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>` : 'Never'}`,
    });

    if (interaction.guild) {
      await logAction(interaction.guild, '🎟️ Promo Created',
        `Staff ${interaction.user} created promo code \`${code}\` (${effectDesc}, ${maxUses} uses).`, 0x5865F2);
    }
    return;
  }

  if (sub === 'list') {
    const promos = await prisma.promoCode.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    if (promos.length === 0) {
      return interaction.editReply({ content: 'ℹ️ No promo codes exist. Create one with `/promo create`.' });
    }

    const lines = promos.map(p => {
      const effectStr = p.effect === 'cooldown_reset'
        ? '🔄 CD Reset'
        : `⬆️ ${p.tierGrant} ${p.durationH}h`;
      const expired = p.expiresAt && p.expiresAt <= new Date();
      const exhausted = p.usedCount >= p.maxUses;
      const status = expired ? '❌ Expired' : exhausted ? '❌ Maxed' : '✅ Active';
      return `\`${p.code}\` — ${effectStr} | ${p.usedCount}/${p.maxUses} uses | ${status}`;
    });

    const embed = new EmbedBuilder()
      .setTitle('🎟️ Promo Codes')
      .setDescription(lines.join('\n'))
      .setColor(0x5865F2)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (sub === 'delete') {
    const code = interaction.options.getString('code')!.trim().toUpperCase();
    const promo = await prisma.promoCode.findUnique({ where: { code } });
    if (!promo) {
      return interaction.editReply({ content: `❌ Promo code **${code}** not found.` });
    }

    await prisma.promoRedemption.deleteMany({ where: { promoId: promo.id } });
    await prisma.promoCode.delete({ where: { id: promo.id } });

    await interaction.editReply({ content: `🗑️ Deleted promo code **${code}** and all its redemptions.` });

    if (interaction.guild) {
      await logAction(interaction.guild, '🗑️ Promo Deleted',
        `Staff ${interaction.user} deleted promo code \`${code}\`.`, 0xED4245);
    }
  }
}
