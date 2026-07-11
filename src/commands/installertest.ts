import { EmbedBuilder, TextChannel } from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { logAction } from '../utils/logging';
import { isEaGame } from '../utils/eaCatalog';
import { isUbisoftGame } from '../utils/ubisoftCatalog';
import { createEaTestInstaller } from '../utils/eaFlow';
import { createUbisoftTestInstaller } from '../utils/ubisoftFlow';

const DEFAULT_GAME = 'EA SPORTS FC 26';

/**
 * /installertest — owner-only: deliver a re-runnable TEST call-home installer
 * for an EA/Ubisoft game to this channel. Like /test, it consumes nothing: the
 * /activate endpoint returns a placeholder token instead of minting a real one,
 * so you can verify the full pipeline (find game → install setup files → launch
 * → capture token_req → write token.ini) without burning a daily activation.
 */
export async function execute(interaction: any): Promise<void> {
  if (interaction.guildId !== CONFIG.OWNER_GUILD_ID) {
    return interaction.editReply({ content: '❌ This command is only available in the owner server.' });
  }

  const channel = interaction.channel;
  if (!channel || !(channel instanceof TextChannel)) {
    return interaction.editReply({ content: '❌ Run this command in a text channel.' });
  }

  if (!CONFIG.INSTALLER_CALLHOME) {
    return interaction.editReply({
      content: '⚠️ `INSTALLER_CALLHOME` is off — the self-driving installer is disabled. The test will still build, but enable the flag before using it with real tickets.',
    });
  }

  const gameName = (interaction.options.getString('game') || DEFAULT_GAME).trim();
  const game = await prisma.game.findFirst({ where: { name: { equals: gameName, mode: 'insensitive' } } });
  if (!game) {
    return interaction.editReply({ content: `❌ No game named **${gameName}**. Pick an EA or Ubisoft title.` });
  }

  const ea = isEaGame(game);
  const ubi = !ea && isUbisoftGame(game);
  if (!ea && !ubi) {
    return interaction.editReply({
      content: `❌ **${game.name}** is neither an EA nor a Ubisoft title. The installer test only applies to those two pipelines.`,
    });
  }

  const result = ea ? await createEaTestInstaller(game) : await createUbisoftTestInstaller(game);
  if (!result.ok) {
    return interaction.editReply({ content: `❌ ${result.message}` });
  }

  const platformLabel = ea ? 'EA' : 'Ubisoft';
  const embed = new EmbedBuilder()
    .setTitle(`🧪 Installer Test — ${game.name}`)
    .setDescription(
      `**${platformLabel} self-driving installer (TEST build).**\n\n` +
        `Download and run it on a PC with **${game.name}** installed via Steam. It will install the setup ` +
        `files, launch the game to capture the activation request, then write a **placeholder** \`token.ini\` ` +
        `(no real token is minted, no activation is used). Re-runnable as many times as you like.`,
    )
    .addFields({ name: '📦 Test Installer', value: `[Download here](${result.url})` })
    .setColor(0xfee75c)
    .setFooter({ text: 'Placeholder token — the game will NOT activate. Delete token.ini after testing.' })
    .setTimestamp();

  await channel.send({ embeds: [embed] });
  await interaction.editReply({ content: `✅ Posted a **${platformLabel}** test installer for **${game.name}** above. Nothing was consumed.` });

  if (interaction.guild) {
    await logAction(interaction.guild, '🧪 Installer Test', `Staff ran \`/installertest\` for **${game.name}** (${platformLabel}) in <#${channel.id}>.`, 0xfee75c);
  }
}
