import { EmbedBuilder } from 'discord.js';
import prisma from '../lib/prisma';
import { generateTestToken } from '../utils/tokenGenerator';
import { uploadFile } from '../utils/fileHost';

export async function execute(interaction: any): Promise<void> {
  const gameName = interaction.options.getString('game')!;
  const game = await prisma.game.findUnique({ where: { name: gameName } });
  if (!game) return interaction.editReply({ content: `❌ **Not Found:** Game **${gameName}** does not exist.` });
  if (!game.appId) return interaction.editReply({ content: `❌ **No AppID:** Game **${gameName}** has no AppID configured.` });

  const startEmbed = new EmbedBuilder()
    .setTitle('🧪 Generating TEST Token')
    .setDescription(`Building a test zip for **${game.name}** (AppID: \`${game.appId}\`).\nUses fake credentials — no Steam authentication, no stock consumed.`)
    .setColor(0xFEE75C)
    .setTimestamp();
  await interaction.editReply({ embeds: [startEmbed] });

  try {
    const { zipPath, logs, installerKey, ticketHash, expectedHmac, appIdBound } = await generateTestToken(game.appId, game.name);
    console.log(`[TestToken] Logs for ${game.name}:\n${logs}`);

    if (zipPath) {
      const safeGameName = game.name.replace(/[<>:"/\\|?*]/g, '').trim();
      const fs = await import('fs');
      const sizeBytes = fs.statSync(zipPath).size;
      const sizeMB = sizeBytes / (1024 * 1024);
      const guild = interaction.guild;
      const tier = guild?.premiumTier ?? 0;
      const limitMB = tier >= 3 ? 100 : tier >= 2 ? 50 : 10;

      try {
        console.log(`[TestToken] Routing zip ${sizeMB.toFixed(1)} MB (limit ${limitMB} MB) through uploadFile for 30-min self-hosted link`);
        await interaction.editReply({ embeds: [
          new EmbedBuilder()
            .setTitle('📤 Uploading TEST Token')
            .setDescription(`Zip is **${sizeMB.toFixed(1)} MB** (Discord limit here is ${limitMB} MB). Uploading to external host...`)
            .setColor(0xFEE75C)
            .setTimestamp()
        ]});
        const upload = await uploadFile(zipPath, '24h', installerKey, { ticketHash, expectedHmac, appIdBound });
        const hostedEmbed = new EmbedBuilder()
          .setTitle('🧪 TEST Token Generated')
          .setDescription(
            `**${game.name}** test zip is ready — use it to verify the template ships correctly.\n\n` +
            `**[⬇️ Download TEST Zip](${upload.url})** _(~${sizeMB.toFixed(1)} MB)_\n\n` +
            `⏱️ ${upload.expiryText}.\n\n` +
            `⚠️ **Fake ticket inside** — this is for layout/install verification only. ` +
            `Do NOT use this zip against a real Denuvo game; activation will fail.\n\n` +
            `🚀 To verify the installer flow end-to-end, extract this zip into its own folder and ` +
            `double-click **\`Install ${safeGameName}.exe\`** as if you were a real user.`
          )
          .setColor(0x57F287)
          .addFields(
            { name: 'AppID', value: `\`${game.appId}\``, inline: true },
            { name: 'Size', value: `\`${sizeMB.toFixed(1)} MB\``, inline: true },
            { name: 'Link host', value: `\`${upload.provider}\``, inline: true }
          )
          .setTimestamp();
        await interaction.editReply({ embeds: [hostedEmbed] });
      } catch (sendErr) {
        const se = sendErr as Error;
        await interaction.editReply({ embeds: [
          new EmbedBuilder()
            .setTitle('🧪 TEST Token — Upload Failed')
            .setDescription(`Built successfully but failed to deliver.\n\n\`\`\`\n${(se?.message || String(se)).slice(0, 400)}\n\`\`\``)
            .setColor(0xED4245)
        ]}).catch(() => {});
      } finally {
        try { fs.unlinkSync(zipPath); } catch {}
      }
    } else {
      const failEmbed = new EmbedBuilder()
        .setTitle('🧪 TEST Token Failed')
        .setDescription(`Could not generate test zip for **${game.name}**.\n\n\`\`\`\n${logs.slice(-500)}\n\`\`\``)
        .setColor(0xED4245)
        .setTimestamp();
      await interaction.editReply({ embeds: [failEmbed] });
    }
  } catch (err) {
    const e = err as Error;
    console.error('[TestToken] Error:', e);
    await interaction.editReply({ content: `❌ **Test Token Error:** ${e.message}` });
  }
}
