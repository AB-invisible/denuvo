import { EmbedBuilder, GuildMember } from 'discord.js';
import {
  getAllGameQueues,
  getQueueRoster,
  canBypassQueue,
  QUEUE_RESERVE_RATIO,
  computeSlotSplit,
} from '../utils/queueManager';
import { isStaffForGuild } from '../utils/permissions';
import { CONFIG } from '../config';

const ROSTER_MAX_PER_GAME = 40;

function formatRosterLines(entries: { position: number; userId: string; joinedAt: Date }[]): string {
  const shown = entries.slice(0, ROSTER_MAX_PER_GAME);
  const lines = shown.map(
    (e) => `#${e.position} — <@${e.userId}> • joined <t:${Math.floor(e.joinedAt.getTime() / 1000)}:R>`,
  );
  if (entries.length > ROSTER_MAX_PER_GAME) {
    lines.push(`_…and ${entries.length - ROSTER_MAX_PER_GAME} more_`);
  }
  return lines.join('\n');
}

export async function execute(interaction: any): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === 'roster') {
    const guildId = interaction.guildId || '';
    const member = interaction.member as GuildMember | null;
    const isStaff = member ? await isStaffForGuild(member, guildId) : false;
    if (!isStaff) {
      return interaction.editReply({
        content: '❌ **Staff only:** `/queue roster` requires staff permissions.',
      });
    }

    const gameName = interaction.options.getString('game');
    const rosters = await getQueueRoster(gameName);

    if (gameName && rosters.length === 0) {
      return interaction.editReply({
        content: `ℹ️ No one is queued for **${gameName}** (or the game was not found).`,
      });
    }

    if (rosters.length === 0) {
      return interaction.editReply({ content: 'ℹ️ No active queues — no users are waiting on any game.' });
    }

    const sections = rosters.map((r) => `**${r.gameName}** (${r.entries.length} waiting)\n${formatRosterLines(r.entries)}`);
    let description = sections.join('\n\n');

    if (description.length > 4000) {
      description = description.slice(0, 3990) + '\n…';
    }

    const embed = new EmbedBuilder()
      .setTitle(gameName ? `📋 Queue Roster — ${gameName}` : '📋 Queue Roster — All Games')
      .setDescription(description)
      .setColor(0x5865F2)
      .setFooter({ text: 'FIFO order • Positions #1 first' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

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
      .setFooter({ text: 'Staff: /queue roster • Users: /waitlist' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  await interaction.editReply({ content: '❌ Unknown subcommand.' });
}
