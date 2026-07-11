import { EmbedBuilder } from 'discord.js';
import { getAllGameQueues, canBypassQueue, QUEUE_RESERVE_RATIO, computeSlotSplit } from '../utils/queueManager';
import { CONFIG } from '../config';

export async function execute(interaction: any): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    const guildId = interaction.guildId || '';
    const summaries = await getAllGameQueues(guildId, interaction.user.id);
    const bypass = interaction.member
      ? await canBypassQueue(interaction.member, guildId)
      : false;

    const generalPct = Math.round((1 - QUEUE_RESERVE_RATIO) * 100);
    const queuePct = Math.round(QUEUE_RESERVE_RATIO * 100);

    if (summaries.length === 0) {
      return interaction.editReply({
        content: 'ℹ️ No games currently have an active queue. When a game is out of stock, you\'ll be added automatically.',
      });
    }

    const lines = summaries.map((s) => {
      const generalLeft = s.generalCapacity - s.generalUsed;
      const queueLeft = s.queueCapacity - s.queueUsed;
      const youTag = s.userPosition !== null ? ` • You: #${s.userPosition}` : '';
      return (
        `**${s.gameName}** — **${s.stock}** total • **${s.queueSize}** waiting\n` +
        `  ↳ ${generalPct}%: **${Math.max(0, generalLeft)}/${s.generalCapacity}** • ` +
        `${queuePct}% queue: **${Math.max(0, queueLeft)}/${s.queueCapacity}**${youTag}`
      );
    });

    const example = computeSlotSplit(10);
    const embed = new EmbedBuilder()
      .setTitle('📋 Game Queues')
      .setDescription(
        lines.join('\n\n') +
        `\n\n` +
        `Total stock is split **${generalPct}/${queuePct}** (e.g. **10** tokens → **${example.generalCapacity}** general + **${example.queueCapacity}** queue).\n` +
        (bypass
          ? '\n✨ You can **bypass** queue limits (Gold / Staff).'
          : `\n💎 Upgrade to **Gold** to bypass: ${CONFIG.PATREON_URL}`),
      )
      .setColor(0x5865F2)
      .setFooter({ text: 'Use /waitlist to view or leave your queues' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  await interaction.editReply({ content: '❌ Unknown subcommand.' });
}
