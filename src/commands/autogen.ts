import prisma from '../lib/prisma';
import { logAction } from '../utils/logging';

export async function execute(interaction: any): Promise<void> {
  const state = interaction.options.getString('state');
  const gameName = interaction.options.getString('game');

  if (gameName) {
    const game = await prisma.game.findUnique({ where: { name: gameName } });
    if (!game) return interaction.editReply({ content: `❌ **Not Found:** Game **${gameName}** does not exist.` });

    const currentlyDisabled = (game as any).autoGenDisabled === true;

    if (!state) {
      await interaction.editReply({
        content: `🤖 **Auto-Gen for ${gameName}:** ${currentlyDisabled ? '🔴 **PAUSED (this game only)**' : '🟢 **ENABLED**'}\n\n` +
          `*Use \`/autogen state:off game:${gameName}\` to pause just this game,*\n` +
          `*or \`/autogen state:on game:${gameName}\` to resume it.*\n\n` +
          `_Note: the global \`/autogen\` flag still applies — if it's paused globally, this game also won't auto-gen regardless of its per-game setting._`
      });
      return;
    }

    const enable = state === 'on';
    const shouldDisable = !enable;
    if (shouldDisable === currentlyDisabled) {
      await interaction.editReply({
        content: `ℹ️ Auto-gen for **${gameName}** is already ${enable ? '🟢 enabled' : '🔴 paused'}. No change.`
      });
      return;
    }

    await prisma.game.update({
      where: { id: game.id },
      data: { autoGenDisabled: shouldDisable } as any,
    });

    await interaction.editReply({
      content: enable
        ? `🟢 **Auto-Gen Resumed for ${gameName}.** Tickets on this game will auto-generate tokens again after screenshot verification.`
        : `🔴 **Auto-Gen Paused for ${gameName}.** New tickets on this game will still verify screenshots, but staff must deliver tokens manually (via \`/tokengen\` or by uploading a zip).`
    });

    if (interaction.guild) {
      await logAction(
        interaction.guild,
        enable ? '🟢 Per-Game Auto-Gen Resumed' : '🔴 Per-Game Auto-Gen Paused',
        `Staff ${interaction.user} ${enable ? 'enabled' : 'paused'} auto-gen for **${gameName}** (AppID \`${game.appId}\`).`,
        enable ? 0x57F287 : 0xED4245
      );
    }
    return;
  }

  const setting = await prisma.metadata.findUnique({ where: { key: 'autoGenEnabled' } });
  const currentlyEnabled = setting?.value !== 'false';

  if (!state) {
    const pausedGames = await prisma.game.findMany({
      where: { autoGenDisabled: true } as any,
      orderBy: { name: 'asc' },
    });
    const pausedList = pausedGames.length
      ? `\n\n**Per-game pauses (${pausedGames.length}):** ${pausedGames.map((g: any) => `\`${g.name}\``).join(', ')}`
      : '';

    await interaction.editReply({
      content: `🤖 **Auto-Generation Status:** ${currentlyEnabled ? '🟢 **ENABLED**' : '🔴 **PAUSED**'}\n\n` +
        `• **When enabled:** bot auto-generates tokens after AI screenshot verification\n` +
        `• **When paused:** screenshots still get verified, but staff must deliver tokens manually\n\n` +
        `Use \`/autogen state:off\` to pause globally, \`/autogen state:on\` to resume.\n` +
        `Use \`/autogen state:off game:<name>\` to pause one game only.` +
        pausedList
    });
    return;
  }

  const enable = state === 'on';
  if (enable === currentlyEnabled) {
    await interaction.editReply({
      content: `ℹ️ Auto-generation is already ${enable ? '🟢 enabled' : '🔴 paused'} globally. No change.`
    });
    return;
  }

  await prisma.metadata.upsert({
    where: { key: 'autoGenEnabled' },
    update: { value: enable ? 'true' : 'false' },
    create: { key: 'autoGenEnabled', value: enable ? 'true' : 'false' }
  });

  await interaction.editReply({
    content: enable
      ? `🟢 **Auto-Generation Resumed (Global).** Bot will now auto-generate tokens after screenshot verification.`
      : `🔴 **Auto-Generation Paused (Global).** New tickets will still verify screenshots, but staff must deliver tokens manually (via \`/tokengen\` or by uploading a zip in the ticket channel).`
  });

  if (interaction.guild) {
    await logAction(
      interaction.guild,
      enable ? '🟢 Auto-Gen Resumed (Global)' : '🔴 Auto-Gen Paused (Global)',
      `Staff ${interaction.user} ${enable ? 'enabled' : 'paused'} automatic token generation globally.`,
      enable ? 0x57F287 : 0xED4245
    );
  }
}
