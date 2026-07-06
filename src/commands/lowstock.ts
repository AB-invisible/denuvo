import prisma from '../lib/prisma';

export async function execute(interaction: any): Promise<void> {
  const threshold = interaction.options.getInteger('threshold');

  if (threshold === null) {
    const setting = await prisma.metadata.findUnique({ where: { key: 'lowStockThreshold' } });
    const current = setting ? parseInt(setting.value) : 3;
    await interaction.editReply({
      content: `📊 **Low Stock Alert Threshold:** \`${current}\`\n\nThe bot alerts the stock notification channel when any game drops to this stock level or below.\nUse \`/lowstock threshold:<number>\` to change it.`,
    });
    return;
  }

  if (threshold < 1 || threshold > 50) {
    return interaction.editReply({ content: '❌ Threshold must be between 1 and 50.' });
  }

  await prisma.metadata.upsert({
    where: { key: 'lowStockThreshold' },
    update: { value: String(threshold) },
    create: { key: 'lowStockThreshold', value: String(threshold) },
  });

  await interaction.editReply({
    content: `✅ **Low Stock Threshold Updated:** Alert will fire when any game drops to **${threshold}** tokens or below.`,
  });
}
