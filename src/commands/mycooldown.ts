import prisma from '../lib/prisma';

export async function execute(interaction: any): Promise<void> {
  const cooldown = await prisma.cooldown.findUnique({ where: { userId: interaction.user.id } });
  if (cooldown && cooldown.until > new Date()) {
    const timeLeft = Math.ceil((cooldown.until.getTime() - Date.now()) / (1000 * 60 * 60));
    const exp = Math.floor(cooldown.until.getTime() / 1000);
    await interaction.editReply({ content: `🛡️ **Denuvo Status:** Active Cooldown\n━━━━━━━━━━━━━━━━━━━━\n⌛ **Duration Remaining:** \`${timeLeft} hours\`\n📅 **Expiration:** <t:${exp}:f>\n━━━━━━━━━━━━━━━━━━━━\n*Further activation attempts are locked until expiry.*` });
  } else {
    await interaction.editReply({ content: `✅ **Denuvo Status:** Cleared\nYour account is currently in good standing. No active cooldowns detected.` });
  }
}
