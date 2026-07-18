import { EmbedBuilder } from 'discord.js';
import crypto from 'crypto';
import { CONFIG } from '../config';

export async function execute(interaction: any): Promise<void> {
  const userId = interaction.user.id;

  if (!CONFIG.PATREON_CLIENT_ID || !CONFIG.PATREON_REDIRECT_URI) {
    return interaction.editReply({
      content: '❌ **Configuration Error:** Patreon OAuth is not configured on this server. Please contact an administrator.',
    });
  }

  const secret = process.env.HMAC_SECRET || 'fallback-secret';
  const hmac = crypto.createHmac('sha256', secret).update(userId).digest('hex');
  const state = `${userId}.${hmac}`;
  const authUrl = `https://www.patreon.com/oauth2/authorize?response_type=code&client_id=${CONFIG.PATREON_CLIENT_ID}&redirect_uri=${encodeURIComponent(CONFIG.PATREON_REDIRECT_URI)}&state=${state}`;

  const embed = new EmbedBuilder()
    .setTitle('🔗 Link Patreon Account')
    .setDescription(
      `To synchronize your Patreon subscription tier and Discord roles, click the link below to authorize our bot.\n\n` +
      `[👉 **Authorize Patreon Link**](${authUrl})\n\n` +
      `*Note: This link is unique to you and will securely connect your Patreon subscription to your Discord ID (<@${userId}>).*`
    )
    .setColor(0xF96854)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
