import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma';
import type { Game } from '@prisma/client';

const JSON_PATH = path.join(__dirname, '../../denuvo.json');

function toDenuvoShape(game: Game) {
  const entry: Record<string, unknown> = {
    name: game.name,
    appId: game.appId,
    disabled: game.disabled,
  };
  if (game.highDemand) entry.highDemand = true;
  if (game.donatorOnly) entry.donatorOnly = true;
  if (game.boosterOnly) entry.boosterOnly = true;
  if (game.steampassUuid) entry.steampassUuid = game.steampassUuid;
  if (game.generationMode && game.generationMode !== 'gbe') {
    entry.generationMode = game.generationMode;
  }
  return entry;
}

export async function execute(interaction: any): Promise<void> {
  const allGames = await prisma.game.findMany({ orderBy: { name: 'asc' } });

  const waitlistCounts = await prisma.waitlist.groupBy({
    by: ['gameId'],
    _count: true,
  });
  const waitlistMap = new Map(waitlistCounts.map((w) => [w.gameId, w._count]));

  const hardcoded = allGames.filter((g) => !g.manuallyAdded);
  const manuallyAdded = allGames.filter((g) => g.manuallyAdded);
  const onPanel = allGames.filter((g) => !g.disabled);

  let jsonFileNames: string[] = [];
  if (fs.existsSync(JSON_PATH)) {
    try {
      const fileData = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
      jsonFileNames = (fileData.games || []).map((g: { name: string }) => g.name);
    } catch {
      // Non-fatal — export still works from DB state.
    }
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    exportedBy: interaction.user.id,
    summary: {
      total: allGames.length,
      onPanel: onPanel.length,
      hidden: allGames.length - onPanel.length,
      hardcoded: hardcoded.length,
      manuallyAdded: manuallyAdded.length,
      denuvoJsonEntries: jsonFileNames.length,
    },
    hardcoded: hardcoded.map((g) => ({
      ...toDenuvoShape(g),
      source: 'denuvo.json',
      inPanel: !g.disabled,
      queueCount: waitlistMap.get(g.id) || 0,
      updatedAt: g.updatedAt.toISOString(),
    })),
    manuallyAdded: manuallyAdded.map((g) => ({
      ...toDenuvoShape(g),
      source: 'manual',
      inPanel: !g.disabled,
      queueCount: waitlistMap.get(g.id) || 0,
      addedAt: g.updatedAt.toISOString(),
    })),
    onPanel: onPanel.map((g) => ({
      name: g.name,
      appId: g.appId,
      source: g.manuallyAdded ? 'manual' : 'denuvo.json',
      queueCount: waitlistMap.get(g.id) || 0,
      generationMode: g.generationMode,
      steampassUuid: g.steampassUuid,
      highDemand: g.highDemand,
      donatorOnly: g.donatorOnly,
      boosterOnly: g.boosterOnly,
    })),
  };

  const json = JSON.stringify(payload, null, 2);
  const filename = `panel-export-${new Date().toISOString().slice(0, 10)}.json`;
  const attachment = new AttachmentBuilder(Buffer.from(json, 'utf8'), { name: filename });

  const embed = new EmbedBuilder()
    .setTitle('📤 Panel Export')
    .setDescription(
      `Exported the full game catalog — **${onPanel.length}** visible on the panel, ` +
      `**${allGames.length - onPanel.length}** hidden.`,
    )
    .addFields(
      { name: 'Hardcoded (denuvo.json)', value: `\`${hardcoded.length}\``, inline: true },
      { name: 'Manually added', value: `\`${manuallyAdded.length}\``, inline: true },
      { name: 'On panel', value: `\`${onPanel.length}\``, inline: true },
    )
    .setColor(0x57F287)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], files: [attachment] });
}
