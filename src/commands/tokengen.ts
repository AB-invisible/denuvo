import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, GuildMember } from 'discord.js';
import prisma from '../lib/prisma';
import { isStaff } from '../utils/permissions';
import { generateTokenWithRetry } from '../utils/tokenGenerator';
import { uploadFile } from '../utils/fileHost';
import { consumeStock } from '../utils/gameManager';
import { createTokenDeliveryEmbed } from '../utils/embeds';
import { logAction, logTenant } from '../utils/logging';
import { pendingVerificationTimers } from '../utils/ticketManager';
import { isUbisoftGame } from '../utils/ubisoftCatalog';
import { startUbisoftDelivery } from '../utils/ubisoftFlow';

export async function execute(interaction: any): Promise<void> {
  const gameName = interaction.options.getString('game')!;
  const deduct = interaction.options.getBoolean('deduct') ?? true;

  if (!isStaff(interaction.member as GuildMember)) {
    return interaction.editReply({ content: '❌ **Unauthorized:** Staff clearance required.' });
  }

  const game = await prisma.game.findUnique({ where: { name: gameName } });
  if (!game) return interaction.editReply({ content: `❌ **Not Found:** Game **${gameName}** does not exist.` });

  // Ubisoft/Denuvo titles use a stateful two-step flow (deliver magic files →
  // collect the user's token request → mint via ubisoft-service), not the
  // Steam generator. /tokengen therefore kicks off that same delivery instead
  // of calling generateTokenWithRetry. It has to run inside the ticket channel
  // because the token-request listener keys off the ticket's ubisoftStage.
  if (isUbisoftGame(game)) {
    const ubiTicket = await prisma.ticket.findFirst({
      where: { channelId: interaction.channelId, status: { in: ['OPEN', 'CLAIMED'] } },
    });
    if (!ubiTicket) {
      return interaction.editReply({
        content:
          `🎮 **${game.name}** is a **Ubisoft/Denuvo** title. Run \`/tokengen\` in the user's ticket channel ` +
          `to deliver the setup package and await their **\`token_req.txt\`** before minting \`token.ini\`.`,
      });
    }
    const channel = interaction.channel;
    if (!channel?.isTextBased()) {
      return interaction.editReply({ content: '❌ This channel is not text-based.' });
    }
    await startUbisoftDelivery(channel, { ...ubiTicket, game }, interaction.guild);
    return interaction.editReply({
      content:
        `🎮 **Ubisoft activation started** for **${game.name}** in <#${interaction.channelId}>.\n` +
        `Setup package delivered — awaiting **\`token_req.txt\`** from the user.\n` +
        `*(Stock deduction isn't applied here; the token is delivered once their request comes back.)*`,
    });
  }

  if (!game.appId) return interaction.editReply({ content: `❌ **No AppID:** Game **${gameName}** has no AppID configured.` });

  const startEmbed = new EmbedBuilder()
    .setTitle('⚙️ Generating Token (Staff Bypass)')
    .setDescription(`Generating a real token for **${game.name}** (AppID: \`${game.appId}\`).\n*Requested by ${interaction.user}.*\nDeduct stock: \`${deduct ? 'YES' : 'NO'}\``)
    .setColor(0x5865F2)
    .setTimestamp();
  await interaction.editReply({ embeds: [startEmbed] });

  let poolAccountId: number | null = null;

  try {
    const retryResult = await generateTokenWithRetry(game.appId, game.name, interaction.guildId);
    const { zipPath, logs, installerKey, ticketHash, expectedHmac, appIdBound } = retryResult;
    poolAccountId = retryResult.poolAccountId;
    if (retryResult.exhausted) {
      return interaction.editReply({ content: `🔴 **${game.name}** is **out of tokens for today.** Fresh tokens unlock at 00:00 UTC — please try again tomorrow.` });
    }
    console.log(`[TokenGen-Cmd] Logs for ${game.name}:\n${logs}`);

    if (!zipPath) {
      const failEmbed = new EmbedBuilder()
        .setTitle('⚠️ Token Generation Failed')
        .setDescription(`Could not generate token for **${game.name}**.\n\n\`\`\`\n${logs.slice(-500)}\n\`\`\``)
        .setColor(0xED4245)
        .setTimestamp();
      await interaction.editReply({ embeds: [failEmbed] });
      if (interaction.guild) {
        await logAction(interaction.guild, '⚠️ /tokengen Failed', `Staff ${interaction.user} ran /tokengen for **${game.name}** — generation failed.\n\`\`\`\n${logs.slice(-500)}\n\`\`\``, 0xED4245);
      }
      return;
    }

    if (deduct) {
      await consumeStock(game.id, interaction.guildId || '').catch(e => console.error('[TokenGen-Cmd] consumeStock failed:', e));
    }

    const safeGameName = game.name.replace(/[<>:"/\\|?*]/g, '').trim();
    const fsMod = await import('fs');
    const zipBytes = fsMod.statSync(zipPath).size;
    const zipMB = zipBytes / (1024 * 1024);
    const tier = interaction.guild?.premiumTier ?? 0;
    const limitMB = tier >= 3 ? 100 : tier >= 2 ? 50 : 10;

    const successFields = [
      { name: '🎮 Game', value: `\`${game.name}\``, inline: true },
      { name: '🆔 AppID', value: `\`${game.appId}\``, inline: true },
      { name: '📦 Size', value: `\`${zipMB.toFixed(1)} MB\``, inline: true },
      { name: '🛠️ Generated by', value: `${interaction.user}`, inline: true },
      { name: '💰 Stock Deducted', value: `\`${deduct ? 'YES' : 'NO'}\``, inline: true },
      { name: '📋 Method', value: '`/tokengen` (staff bypass)', inline: true },
    ];

    const ticketHere = await prisma.ticket.findFirst({
      where: { channelId: interaction.channelId, status: { in: ['OPEN', 'CLAIMED'] } }
    });
    const worksRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('works_yes').setLabel('Confirm Working').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('works_no').setLabel('Report Issue').setStyle(ButtonStyle.Danger)
    );

    const persistent = !ticketHere;

    try {
      let delivered: any;
      await interaction.editReply({ embeds: [
        new EmbedBuilder()
          .setTitle('📤 Uploading Token')
          .setDescription(`Zip is **${zipMB.toFixed(1)} MB** (Discord limit here is ${limitMB} MB). Uploading to file host...`)
          .setColor(0xFEE75C)
          .setTimestamp()
      ] });
      const upload = await uploadFile(zipPath, '72h', installerKey, { ticketHash, expectedHmac, appIdBound }, persistent);
      const hostedEmbed = createTokenDeliveryEmbed(
        game.name,
        ticketHere?.userId || interaction.user.id,
        interaction.user,
        { url: upload.url, expiryText: upload.expiryText, sizeMB: zipMB.toFixed(1) },
      ).addFields(successFields);

      // Post a visible channel message — auto-gen does the same. Relying on
      // editReply alone buries the download link in the slash-command reply,
      // which staff/users often miss (especially outside a ticket channel).
      const targetChannel = interaction.channel;
      if (!targetChannel?.isTextBased()) {
        throw new Error('Cannot post delivery embed — channel is not text-based.');
      }
      delivered = await targetChannel.send({
        embeds: [hostedEmbed],
        components: ticketHere ? [worksRow] : [],
      });

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('✅ /tokengen Delivered')
            .setDescription(
              `Token delivery embed posted → [jump to message](${delivered.url})\n\n` +
              `**[⬇️ Download Token Zip](${upload.url})** · ${upload.expiryText}`,
            )
            .addFields(successFields)
            .setColor(0x57F287)
            .setTimestamp(),
        ],
        components: [],
      });

      if (ticketHere && delivered?.id) {
        await prisma.ticket.update({
          where: { id: ticketHere.id },
          data: {
            deliveryMessageId: delivered.id,
            staffId: interaction.user.id,
            screenshotVerified: true,
            ...(ticketHere.claimedAt ? {} : { claimedAt: new Date() }),
            status: 'CLAIMED'
          }
        }).catch(e => console.error('[TokenGen-Cmd] ticket update failed:', e));
        const tTimer = pendingVerificationTimers.get(interaction.channelId);
        if (tTimer) { clearTimeout(tTimer); pendingVerificationTimers.delete(interaction.channelId); }
        await delivered.react?.('❤️').catch(() => {});
      }
      if (interaction.guild) {
        await logAction(interaction.guild, '🛠️ /tokengen Delivered',
          `Staff ${interaction.user} generated a token via **/tokengen** for **${game.name}** (AppID \`${game.appId}\`, ${zipMB.toFixed(1)} MB).\n` +
          `**Stock Deducted:** \`${deduct ? 'YES' : 'NO'}\`\n` +
          `**In ticket channel:** ${ticketHere ? `<#${interaction.channelId}>` : 'no — posted in a regular channel'}\n` +
          `**Delivery message:** ${delivered.url}\n` +
          `**Download:** ${upload.url}\n` +
          `**Link type:** ${persistent ? '🔓 **Persistent** (never expires, installer re-runnable)' : '⏱️ Single-use (expires + consumed on first install)'}`,
          0x57F287);
      }
      await logTenant(interaction.guildId, '📦 Token Delivered', `A token for **${game.name}** was delivered to <@${ticketHere?.userId || interaction.user.id}>.`, 0x57F287);
    } catch (sendErr) {
      const se = sendErr as Error;
      console.error('[TokenGen-Cmd] Delivery failed:', se);
      await interaction.editReply({ embeds: [
        new EmbedBuilder()
          .setTitle('⚠️ Token Built But Failed to Send')
          .setDescription(`Token generation succeeded but delivery failed:\n\`\`\`\n${(se?.message || String(se)).slice(0, 400)}\n\`\`\``)
          .setColor(0xED4245)
      ] }).catch(() => {});
    } finally {
      try { fsMod.unlinkSync(zipPath); } catch {}
    }
  } catch (err) {
    const e = err as Error;
    console.error('[TokenGen-Cmd] Error:', e);
    await interaction.editReply({ content: `❌ **/tokengen Error:** ${e.message}` });
  }
}
