import { EmbedBuilder } from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { logAction } from '../utils/logging';
import { UBISOFT_CATALOG, resolveUbisoftForGame } from '../utils/ubisoftCatalog';

/**
 * /ubisoftgame — owner-only: mark a game as a Ubisoft/Denuvo title and set
 * its Ubisoft AppID(s) + magic-files zip. Once ubisoftAppId is set, that
 * game switches to the two-step magic-files + token_req flow.
 *
 *   /ubisoftgame set game:<name> appid:<ubisoftAppId> [alt_appid] [magic_file]
 *   /ubisoftgame clear game:<name>
 *   /ubisoftgame list
 */
export async function execute(interaction: any): Promise<void> {
  if (interaction.guildId !== CONFIG.OWNER_GUILD_ID) {
    return interaction.editReply({ content: '❌ This command is only available in the owner server.' });
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'set') {
    const name = interaction.options.getString('game', true).trim();
    const appId = interaction.options.getInteger('appid', true);
    const altAppId = interaction.options.getInteger('alt_appid');
    const magicFile = (interaction.options.getString('magic_file') || '').trim() || null;

    if (appId <= 0) return interaction.editReply({ content: '❌ Ubisoft AppID must be a positive number.' });

    const game = await prisma.game.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (!game) return interaction.editReply({ content: `❌ No game named **${name}**. Add it first.` });

    try {
      await prisma.game.update({
        where: { id: game.id },
        data: {
          ubisoftAppId: appId,
          ubisoftAltAppId: altAppId ?? null,
          ...(magicFile ? { ubisoftMagicFile: magicFile } : {}),
        } as any,
      });
      const resolved = resolveUbisoftForGame({ ...game, ubisoftAppId: appId, ubisoftAltAppId: altAppId ?? null, ubisoftMagicFile: magicFile });
      await interaction.editReply({
        content:
          `✅ **${game.name}** is now a **Ubisoft** title.\n` +
          `• Ubisoft AppID: \`${appId}\`${altAppId ? ` (fallback \`${altAppId}\`)` : ''}\n` +
          `• Magic files: \`${resolved?.magicFile ?? 'not set'}\`\n\n` +
          `Verified tickets for this game now get the magic files + token_req flow.`,
      });
      if (interaction.guild) {
        await logAction(interaction.guild, '🎮 Ubisoft Game Configured', `Owner set **${game.name}** → Ubisoft AppID \`${appId}\`${altAppId ? ` / \`${altAppId}\`` : ''}.`, 0x57F287);
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
        data: { ubisoftAppId: null, ubisoftAltAppId: null, ubisoftMagicFile: null } as any,
      });
      await interaction.editReply({ content: `🗑️ **${game.name}** is no longer a Ubisoft title (reverts to the normal flow).` });
      if (interaction.guild) {
        await logAction(interaction.guild, '🗑️ Ubisoft Game Cleared', `Owner cleared Ubisoft config on **${game.name}**.`, 0xFEE75C);
      }
    } catch (e) {
      return interaction.editReply({ content: `❌ Failed to clear: ${(e as Error).message}` });
    }
    return;
  }

  // ── list ──
  const games = await prisma.game.findMany({ orderBy: { name: 'asc' } });
  const ubiGames = games.filter((g: any) => g.ubisoftAppId || (g.appId && UBISOFT_CATALOG.some((c) => c.steamAppId === g.appId && c.ubisoftAppId)));

  let lines = '';
  for (const g of ubiGames) {
    const r = resolveUbisoftForGame(g as any);
    if (!r) continue;
    const src = (g as any).ubisoftAppId ? 'db' : 'catalog';
    lines += `**${g.name}** → \`${r.ubisoftAppId}\`${r.ubisoftAltAppId ? `/\`${r.ubisoftAltAppId}\`` : ''} · ${r.magicFile ?? 'no file'} _(from ${src})_\n`;
  }

  // Catalog entries still missing an AppID (need /ubisoftgame set).
  const pending = UBISOFT_CATALOG.filter((c) => !c.ubisoftAppId).map((c) => `• ${c.name} — needs AppID (\`${c.magicFile}\`)`);

  const embed = new EmbedBuilder()
    .setTitle('🎮 Ubisoft Games')
    .setDescription(lines || '_No games are configured as Ubisoft titles yet._')
    .setColor(0x5865F2)
    .setTimestamp();
  if (pending.length) embed.addFields({ name: 'Pending (no AppID in catalog)', value: pending.join('\n') });
  await interaction.editReply({ embeds: [embed] });
}
