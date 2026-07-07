import { EmbedBuilder } from 'discord.js';
import { getTrustScore } from '../utils/trustScore';

export async function execute(interaction: any): Promise<void> {
  const user = interaction.options.getUser('user')!;

  const trust = await getTrustScore(user.id, interaction.guildId || '');

  const embed = new EmbedBuilder()
    .setTitle(`🛡️ Trust Score — ${user.username}`)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'Score', value: `\`${trust.score}\``, inline: true },
      { name: 'Rank', value: trust.rank, inline: true },
      { name: '​', value: '​', inline: true },
      { name: '✅ Successful Deliveries', value: `\`${trust.successes}\` (+10 each)`, inline: true },
      { name: '❌ Failed Verifications', value: `\`${trust.failures}\` (-20 each)`, inline: true },
      { name: '​', value: '​', inline: true },
    )
    .setColor(trust.score >= 50 ? 0x57F287 : trust.score >= 0 ? 0x5865F2 : 0xED4245)
    .setDescription(
      trust.score >= 50
        ? '⭐ **Trusted User** — This user has a strong verification history.'
        : trust.score < 0
          ? '🔴 **Flagged** — This user has more failures than successes.'
          : 'Standard verification applies for this user.'
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
