import { EmbedBuilder, TextChannel } from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { logAction } from '../utils/logging';
import { sendEaMagicPackage } from '../utils/eaFlow';
import { isEaGame } from '../utils/eaCatalog';

const DEFAULT_GAME = 'EA SPORTS FC 26';

/**
 * /eatest — owner-only: deliver EA magic files to the channel (no ticket flow).
 */
export async function execute(interaction: any): Promise<void> {
  if (interaction.guildId !== CONFIG.OWNER_GUILD_ID) {
    return interaction.editReply({ content: '❌ This command is only available in the owner server.' });
  }

  const channel = interaction.channel;
  if (!channel || !(channel instanceof TextChannel)) {
    return interaction.editReply({ content: '❌ Run this command in a text channel.' });
  }

  const gameName = (interaction.options.getString('game') || DEFAULT_GAME).trim();
  const game = await prisma.game.findFirst({
    where: { name: { equals: gameName, mode: 'insensitive' } },
  });
  if (!game) {
    return interaction.editReply({ content: `❌ No game named **${gameName}**. Add it first or pick another EA title.` });
  }
  if (!isEaGame(game)) {
    return interaction.editReply({
      content: `❌ **${game.name}** is not an EA title. Configure it with \`/eagame set\` first.`,
    });
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle('🧪 EA Magic Files Test')
        .setDescription(`Sending setup package for **${game.name}** to this channel…`)
        .setColor(0xfee75c)
        .setTimestamp(),
    ],
  });

  const result = await sendEaMagicPackage(channel, game, { test: true });
  if (!result.ok) {
    return interaction.editReply({
      content: `❌ ${result.message}`,
      embeds: [],
    });
  }

  const linkLine = result.url ? `[hosted link](${result.url})` : 'local attachment only';
  const sizeLine = result.sizeMB ? ` · **${result.sizeMB.toFixed(1)} MB**` : '';
  await interaction.editReply({
    content:
      `✅ Posted EA magic delivery for **${game.name}** above (${linkLine}${sizeLine}). ` +
      `No ticket state was changed.`,
    embeds: [],
  });

  if (interaction.guild) {
    await logAction(
      interaction.guild,
      '🧪 EA Magic Test',
      `Staff ran \`/eatest\` for **${game.name}** in <#${channel.id}>.`,
      0xfee75c,
    );
  }
}
