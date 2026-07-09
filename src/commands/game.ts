import prisma from '../lib/prisma';
import { purgeGameCascade, initServerStocksForGame } from '../utils/gameManager';
import { refreshAllPanels } from '../utils/panelManager';
import { logAction } from '../utils/logging';

export async function execute(interaction: any): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const name = interaction.options.getString('name')!.trim();
    const appId = interaction.options.getInteger('appid')!;
    const steampass = interaction.options.getString('product-uuid') || null;
    const tier = interaction.options.getString('tier') || 'normal';
    const stock = interaction.options.getInteger('stock') ?? 5;

    const existing = await prisma.game.findUnique({ where: { name } });
    if (existing) {
      return interaction.editReply({
        content: `❌ **Already Exists:** A game named **${name}** is already in the catalog.\n*Use \`/game state\` to toggle visibility, or \`/game tier\` to change its category.*`
      });
    }

    const tierFlags: any = { highDemand: false, donatorOnly: false, boosterOnly: false };
    if (tier === 'high') tierFlags.highDemand = true;
    else if (tier === 'donor') tierFlags.donatorOnly = true;
    else if (tier === 'booster') tierFlags.boosterOnly = true;

    await prisma.game.create({
      data: {
        name,
        appId,
        stock,
        steampassUuid: steampass,
        manuallyAdded: true,
        disabled: false,
        generationMode: 'gbe',
        ...tierFlags,
      } as any,
    });

    const newGame = await prisma.game.findUnique({ where: { name } });
    if (newGame) await initServerStocksForGame(newGame.id);

    await refreshAllPanels();

    const tierEmoji: Record<string, string> = { normal: '🟢', high: '🔥', donor: '💎', booster: '✨' };
    await interaction.editReply({
      content: `✅ **Added:** ${tierEmoji[tier]} **${name}** (AppID \`${appId}\`)\n` +
        `• Stock: \`${stock}\`\n` +
        `• Tier: \`${tier}\`\n` +
        `• Token generation: ${steampass ? `enabled` : `**disabled** — no product UUID provided. Set one later via DB or re-add.`}\n` +
        `• Mode: \`gbe\` (default)\n\n` +
        `Manually-added games are protected from the denuvo.json sync (won't be auto-disabled).`
    });

    if (interaction.guild) {
      await logAction(interaction.guild, '🆕 Game Added',
        `Staff ${interaction.user} added **${name}** (AppID \`${appId}\`, tier \`${tier}\`, stock \`${stock}\`).`,
        0x57F287);
    }
    return;
  }

  if (sub === 'delete') {
    const gameName = interaction.options.getString('game')!;
    const game = await prisma.game.findUnique({ where: { name: gameName } });
    if (!game) return interaction.editReply({ content: `❌ **Not Found:** **${gameName}** doesn't exist.` });

    if (!(game as any).manuallyAdded) {
      return interaction.editReply({
        content: `❌ **Cannot Delete:** **${gameName}** comes from \`denuvo.json\` — it's not safe to delete here because the next sync would re-create it.\n` +
          `*To remove it permanently, edit \`denuvo.json\` and remove its entry. Or use \`/game state game:${gameName} state:off\` to just hide it.*`
      });
    }

    const activeTickets = await prisma.ticket.count({
      where: { gameId: game.id, status: { in: ['OPEN', 'CLAIMED'] } }
    });
    if (activeTickets > 0) {
      return interaction.editReply({
        content: `❌ **Cannot Delete:** **${gameName}** has ${activeTickets} active ticket(s). Close them first.`
      });
    }

    await purgeGameCascade(game.id);
    await refreshAllPanels();
    await interaction.editReply({ content: `🗑️ **Deleted:** **${gameName}** removed from catalog.` });

    if (interaction.guild) {
      await logAction(interaction.guild, '🗑️ Game Deleted',
        `Staff ${interaction.user} permanently deleted manually-added game **${gameName}** (AppID \`${game.appId}\`).`,
        0xED4245);
    }
    return;
  }

  const gameName = interaction.options.getString('game')!;
  const game = await prisma.game.findUnique({ where: { name: gameName } });
  if (!game) return interaction.editReply({ content: `❌ **Not Found:** Game **${gameName}** does not exist.` });

  if (sub === 'state') {
    const state = interaction.options.getString('state')!;
    const disabled = state === 'off';
    await prisma.game.update({ where: { id: game.id }, data: { disabled } });
    await refreshAllPanels();

    const msg = disabled
      ? `🔒 **${gameName}** is now **hidden** from the panel. Existing tickets are unaffected.`
      : `🔓 **${gameName}** is now **visible** on the panel.`;
    await interaction.editReply({ content: msg });

    if (interaction.guild) {
      await logAction(interaction.guild, disabled ? '🔒 Game Hidden' : '🔓 Game Shown',
        `Staff ${interaction.user} set **${gameName}** to \`${state}\`.`,
        disabled ? 0xED4245 : 0x57F287);
    }
  } else if (sub === 'tier') {
    const tier = interaction.options.getString('tier')!;
    const data: any = { highDemand: false, donatorOnly: false, boosterOnly: false };
    if (tier === 'high') data.highDemand = true;
    else if (tier === 'donor') data.donatorOnly = true;
    else if (tier === 'booster') data.boosterOnly = true;

    await prisma.game.update({ where: { id: game.id }, data });
    await refreshAllPanels();

    const tierInfo: Record<string, { emoji: string; label: string; cooldown: string; access: string }> = {
      normal: { emoji: '🟢', label: 'Normal', cooldown: '24h', access: 'anyone' },
      high: { emoji: '🔥', label: 'High Demand', cooldown: '48h', access: 'anyone' },
      donor: { emoji: '💎', label: 'Donor Only', cooldown: '2h', access: 'donors only' },
      booster: { emoji: '✨', label: 'Booster Only', cooldown: '24h', access: 'boosters + donors' },
    };
    const info = tierInfo[tier];

    await interaction.editReply({
      content: `${info.emoji} **${gameName}** set to **${info.label}**.\n• Access: **${info.access}**\n• Cooldown after delivery: **${info.cooldown}**`
    });

    if (interaction.guild) {
      await logAction(interaction.guild, `${info.emoji} Tier Changed`,
        `Staff ${interaction.user} set **${gameName}** to **${info.label}** (cooldown \`${info.cooldown}\`, access \`${info.access}\`).`,
        0x5865F2);
    }
  }
}
