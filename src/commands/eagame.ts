import { EmbedBuilder } from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { logAction } from '../utils/logging';
import { resolveEaForGame } from '../utils/eaCatalog';

/**
 * /eagame — owner-only: mark a game as an EA/Origin Denuvo title.
 *
 *   /eagame set game:<name> content_id:<id> engine:<engine> [magic_file]
 *   /eagame clear game:<name>
 *   /eagame list
 */
export async function execute(interaction: any): Promise<void> {
  if (interaction.guildId !== CONFIG.OWNER_GUILD_ID) {
    return interaction.editReply({ content: '❌ This command is only available in the owner server.' });
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'set') {
    const name = interaction.options.getString('game', true).trim();
    const contentId = interaction.options.getInteger('content_id', true);
    const engine = interaction.options.getString('engine', true).trim();
    const magicFile = (interaction.options.getString('magic_file') || '').trim() || null;

    if (contentId <= 0) return interaction.editReply({ content: '❌ Content ID must be a positive number.' });
    if (!engine) return interaction.editReply({ content: '❌ Engine is required (e.g. `2_1_0`).' });

    const game = await prisma.game.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (!game) return interaction.editReply({ content: `❌ No game named **${name}**. Add it first.` });

    try {
      await prisma.game.update({
        where: { id: game.id },
        data: {
          eaContentId: contentId,
          eaEngine: engine,
          ...(magicFile ? { eaMagicFile: magicFile } : {}),
        } as any,
      });
      const resolved = resolveEaForGame({ ...game, eaContentId: contentId, eaEngine: engine, eaMagicFile: magicFile });
      await interaction.editReply({
        content:
          `✅ **${game.name}** is now an **EA/Origin** title.\n` +
          `• Content ID: \`${contentId}\`\n` +
          `• Engine: \`${engine}\`\n` +
          `• Setup zip: \`${resolved?.magicFile ?? 'not set'}\`\n\n` +
          `Verified tickets for this game now get the setup files + ticket flow.`,
      });
      if (interaction.guild) {
        await logAction(
          interaction.guild,
          '🎮 EA Game Configured',
          `Owner set **${game.name}** → contentId \`${contentId}\`, engine \`${engine}\`.`,
          0x57f287,
        );
      }
    } catch (e) {
      return interaction.editReply({ content: `❌ Failed to update: ${(e as Error).message}` });
    }
    return;
  }

  if (sub === 'clear') {
    const name = interaction.options.getString('game', true).trim();
    const game = await prisma.game.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (!game) return interaction.editReply({ content: `❌ No game named **${name}**.` });
    try {
      await prisma.game.update({
        where: { id: game.id },
        data: { eaContentId: null, eaEngine: null, eaMagicFile: null } as any,
      });
      await interaction.editReply({ content: `🗑️ **${game.name}** is no longer an EA title (reverts to the normal flow).` });
      if (interaction.guild) {
        await logAction(interaction.guild, '🗑️ EA Game Cleared', `Owner cleared EA config on **${game.name}**.`, 0xfee75c);
      }
    } catch (e) {
      return interaction.editReply({ content: `❌ Failed to clear: ${(e as Error).message}` });
    }
    return;
  }

  const games = await prisma.game.findMany({ orderBy: { name: 'asc' } });
  const eaGames = games.filter((g: any) => g.eaContentId && g.eaEngine);
  if (!eaGames.length) {
    return interaction.editReply({ content: '📭 No EA games configured. Use `/eagame set`.' });
  }

  const lines = eaGames.map((g: any) => {
    const magic = g.eaMagicFile ? ` · zip \`${g.eaMagicFile}\`` : '';
    return `• **${g.name}** — contentId \`${g.eaContentId}\`, engine \`${g.eaEngine}\`${magic}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('🎮 EA / Origin Games')
    .setDescription(lines.join('\n'))
    .setColor(0x5865f2)
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}
