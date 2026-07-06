import prisma from '../lib/prisma';

export async function execute(interaction: any): Promise<void> {
  const cooldown = await prisma.cooldown.findUnique({ where: { userId: interaction.user.id } });
  if (cooldown && cooldown.until > new Date()) {
    const exp = Math.floor(cooldown.until.getTime() / 1000);
    await interaction.editReply({ content: `🛡️ **Denuvo Status:** Active Cooldown\n━━━━━━━━━━━━━━━━━━━━\n⌛ **Expires:** <t:${exp}:R>\n📅 **Expiration:** <t:${exp}:f>\n━━━━━━━━━━━━━━━━━━━━\n*Further activation attempts are locked until expiry.*` });
  } else {
    await interaction.editReply({ content: `✅ **Denuvo Status:** Cleared\nYour account is currently in good standing. No active cooldowns detected.` });
  }
}
