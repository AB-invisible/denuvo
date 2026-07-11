/**
 * ubisoftFlow.ts — the two-step Ubisoft (Uplay/Denuvo) delivery flow.
 *
 * Unlike Steam (one screenshot → one token zip), Ubisoft Denuvo needs a
 * round-trip with the user's own machine:
 *
 *   1. Screenshot verifies (same pipeline as Steam).
 *   2. startUbisoftDelivery(): bot delivers the game's "magic files" zip +
 *      instructions and flips ticket.ubisoftStage = 'AWAITING_TOKEN_REQ'.
 *   3. User extracts the files, launches the game once; the crack produces a
 *      NEW token request string (token_req) which the user pastes back into
 *      the ticket.
 *   4. handleUbisoftTokenReq(): bot sends {ubisoftAppId, token_req} to
 *      ubisoft-service, gets {token, ownership}, and delivers token.ini.
 *
 * token.ini format matches exactly what DenuvoTicket writes so the game
 * reads it unchanged:  [token]\ntoken=<t>\nownership=<o>
 */

import {
  TextChannel,
  Guild,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  Message,
} from 'discord.js';
import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { client } from '../client';
import { logAction, logTenant } from './logging';
import { resolveUbisoftForGame, catalogByMagicFile } from './ubisoftCatalog';
import { mintUbisoftToken, ubisoftServiceConfigured } from './ubisoftService';
import { resolvePublicBaseUrl } from './downloadHost';

export const UBISOFT_STAGE_AWAITING = 'AWAITING_TOKEN_REQ';
export const UBISOFT_STAGE_DONE = 'DONE';

// The Denuvo token_req is a long opaque string. Guard against someone
// pasting "here you go" — require a substantial blob of token-ish chars.
const TOKEN_REQ_MIN_LEN = 40;
const TOKEN_REQ_RE = /[A-Za-z0-9+/=_\-.:]{40,}/;

function homeGuild() {
  return client.guilds.cache.get(CONFIG.GUILD_ID) ?? null;
}

async function staffPingFor(guildId: string): Promise<string> {
  const sc = await (await import('./tenant')).resolveServerConfig(guildId);
  return sc.staffPing;
}

/**
 * Resolve where to source the magic-files zip. Prefers a self-hosted link
 * (payloadServer /ubisoft/magic/<appId>) when PUBLIC_URL is set; otherwise
 * tries to attach the file directly from UBISOFT_MAGIC_DIR if it fits.
 */
function resolveMagicDelivery(
  ubisoftAppId: number,
  magicFile: string | null,
): { url?: string; localPath?: string; sizeMB?: number } | null {
  const base = resolvePublicBaseUrl();
  const dir = (CONFIG.UBISOFT_MAGIC_DIR || '').trim();

  let localPath: string | undefined;
  let sizeMB: number | undefined;
  if (dir && magicFile) {
    const candidate = path.join(dir, magicFile);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      localPath = candidate;
      sizeMB = fs.statSync(candidate).size / (1024 * 1024);
    }
  }

  // Link is preferred (no Discord size limits, cacheable). Only valid if the
  // file is actually present for the payload server to stream.
  const url = base && localPath ? `${base}/ubisoft/magic/${ubisoftAppId}` : undefined;

  if (!url && !localPath) return null;
  return { url, localPath, sizeMB };
}

function magicInstructions(gameName: string, layout: 'flat' | 'bin64'): string {
  const dropTarget =
    layout === 'bin64'
      ? 'the game install folder (the zip already contains the `Bin/Win64/` structure — extract it at the game root and let it merge)'
      : 'the game install folder, next to the main game `.exe`';

  return (
    `**Step 1 — Install the files**\n` +
    `1. Download the file above and extract it.\n` +
    `2. Copy everything (\`dbdata.dll\`, \`steam_api64.dll\`, \`steamclient64.dll\`, \`upc_r2*\`, and the \`steam_settings\` folder) into ${dropTarget}. Overwrite if asked.\n\n` +
    `**Step 2 — Get your token request**\n` +
    `3. Launch **${gameName}** once. It will fail to start and generate a **token request** (a long text string / a \`token_req\` file).\n` +
    `4. Copy that entire token request and **paste it here** (or attach the \`.txt\` file). I'll turn it into your \`token.ini\` automatically.`
  );
}

/**
 * Step 2 of the flow: magic files + instructions, then wait for token_req.
 * Called instead of autoGenerateAndDeliver for Ubisoft games right after the
 * screenshot verifies (or staff approves it).
 */
export async function startUbisoftDelivery(channel: TextChannel, ticket: any, guild: Guild | null): Promise<void> {
  const guildId = ticket.guildId ?? guild?.id ?? '';
  const staffPing = await staffPingFor(guildId);
  const hg = homeGuild();

  const resolved = resolveUbisoftForGame(ticket.game);
  if (!resolved) {
    await channel.send({ content: `${staffPing} **${ticket.game.name}** is flagged Ubisoft but has no Ubisoft AppID configured. Set it with \`/ubisoftgame\`.` });
    return;
  }

  const delivery = resolveMagicDelivery(resolved.ubisoftAppId, resolved.magicFile);
  if (!delivery) {
    await channel.send({
      content:
        `${staffPing} Screenshot verified for **${ticket.game.name}**, but the magic-files zip ` +
        `(\`${resolved.magicFile ?? 'unknown'}\`) isn't available. Upload it to \`UBISOFT_MAGIC_DIR\` or set \`PUBLIC_URL\`. Manual delivery needed.`,
    });
    if (hg) {
      await logAction(hg, '⚠️ Ubisoft Magic Files Missing', `No magic-files zip for **${ticket.game.name}** (appId \`${resolved.ubisoftAppId}\`, file \`${resolved.magicFile ?? '?'}\`) in <#${channel.id}>.`, 0xED4245);
    }
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`🎮 ${ticket.game.name} — Ubisoft Setup`)
    .setDescription(
      `Your screenshot is verified. **${ticket.game.name}** is a Ubisoft/Denuvo title, so this is a **two-step** process.\n\n` +
        magicInstructions(ticket.game.name, resolved.layout),
    )
    .setColor(0x5865f2)
    .setFooter({ text: 'Waiting for your token request…' })
    .setTimestamp();

  if (delivery.url) {
    embed.addFields({ name: '📦 Magic Files', value: `[Download here](${delivery.url})` });
  }

  const files: AttachmentBuilder[] = [];
  // Attach directly when we have the file locally and it fits Discord's
  // base 25 MB boundary — most reliable for the user (no external click).
  if (delivery.localPath && (delivery.sizeMB ?? 99) <= 24) {
    files.push(new AttachmentBuilder(delivery.localPath, { name: path.basename(delivery.localPath) }));
  }

  await channel.send({ embeds: [embed], ...(files.length ? { files } : {}) });

  await prisma.ticket.update({
    where: { id: ticket.id },
    data: { ubisoftStage: UBISOFT_STAGE_AWAITING, screenshotVerified: true, staffId: client.user!.id } as any,
  });

  if (hg) {
    await logAction(hg, '🎮 Ubisoft Setup Delivered', `Delivered magic files for **${ticket.game.name}** (appId \`${resolved.ubisoftAppId}\`) in <#${channel.id}>. Awaiting token request.`, 0x5865f2);
  }
  if (guildId) {
    await logTenant(guildId, '🎮 Ubisoft Setup Delivered', `Magic files for **${ticket.game.name}** delivered to <@${ticket.userId}>. Awaiting their token request.`, 0x5865f2);
  }
}

/** Pull the token_req out of a message body or attached .txt file. */
async function extractTokenReq(message: Message): Promise<string | null> {
  const attach = message.attachments.find((a) =>
    (a.name || '').toLowerCase().endsWith('.txt') || (a.name || '').toLowerCase().endsWith('.ini') || (a.contentType || '').startsWith('text/'),
  );
  if (attach) {
    try {
      const res = await fetch(attach.url);
      const text = (await res.text()).trim();
      const m = text.match(TOKEN_REQ_RE);
      if (m) return m[0];
      if (text.length >= TOKEN_REQ_MIN_LEN) return text;
    } catch {
      /* fall through to body */
    }
  }

  const body = (message.content || '').trim();
  // Prefer a fenced/plain long token-ish blob; else accept the whole body if
  // it's a single long line with no spaces (a pasted request).
  const codeStripped = body.replace(/```[a-z]*\n?|```/gi, '').trim();
  const m = codeStripped.match(TOKEN_REQ_RE);
  if (m) return m[0];
  if (codeStripped.length >= TOKEN_REQ_MIN_LEN && !/\s/.test(codeStripped)) return codeStripped;
  return null;
}

/**
 * Step 4 of the flow: the user posted their token_req. Mint the token and
 * deliver token.ini. Returns true when this message was consumed as a
 * token_req submission (so the caller stops further processing).
 */
export async function handleUbisoftTokenReq(message: Message, ticket: any): Promise<boolean> {
  const channel = message.channel as TextChannel;
  const guildId = ticket.guildId ?? message.guildId ?? '';
  const staffPing = await staffPingFor(guildId);
  const hg = homeGuild();

  const tokenReq = await extractTokenReq(message);
  if (!tokenReq) {
    // Not a token request — likely just chatter. Nudge once, don't spam.
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('❓ That doesn’t look like a token request')
          .setDescription(
            `I’m waiting for the **token request** produced by **${ticket.game.name}** after you launch it.\n\n` +
              `Paste the full request string here, or attach the \`.txt\` file it created.`,
          )
          .setColor(0xfee75c),
      ],
    }).catch(() => {});
    return true;
  }

  if (!ubisoftServiceConfigured()) {
    await channel.send({ content: `${staffPing} Ubisoft token service isn't configured (\`UBISOFT_SERVICE_URL\`/\`UBISOFT_SERVICE_KEY\`). Manual delivery needed for **${ticket.game.name}**.` });
    return true;
  }

  const resolved = resolveUbisoftForGame(ticket.game);
  if (!resolved) {
    await channel.send({ content: `${staffPing} **${ticket.game.name}** has no Ubisoft AppID configured. Set it with \`/ubisoftgame\`.` });
    return true;
  }

  const genMsg = await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle('⚙️ Generating Ubisoft Token…')
        .setDescription(`Minting your token for **${ticket.game.name}** (AppID \`${resolved.ubisoftAppId}\`). This can take up to a minute.`)
        .setColor(0x5865f2)
        .setTimestamp(),
    ],
  });

  const result = await mintUbisoftToken(resolved.ubisoftAppId, resolved.ubisoftAltAppId, tokenReq, guildId);

  if (!result.ok) {
    if (result.exhausted || result.code === 'ExceededActivations') {
      await genMsg.edit({
        embeds: [
          new EmbedBuilder()
            .setTitle('🔴 Out of Tokens Today')
            .setDescription(`**${ticket.game.name}** is **out of Ubisoft activations for today.** Fresh activations unlock at 00:00 UTC — please try again tomorrow.`)
            .setColor(0xed4245)
            .setTimestamp(),
        ],
      });
      return true;
    }

    const friendly =
      result.code === 'NotOwned'
        ? `Our Ubisoft account doesn’t own **${ticket.game.name}** on the configured AppID. Staff has been notified.`
        : result.code === 'InvalidRequest'
        ? `That token request looks malformed. Re-launch **${ticket.game.name}** and paste the **full** new request.`
        : result.code === 'LoginFailed'
        ? `Ubisoft login failed on our side. Staff has been notified.`
        : `Token generation failed. Staff has been notified.`;

    await genMsg.edit({
      embeds: [new EmbedBuilder().setTitle('⚠️ Generation Failed').setDescription(friendly).setColor(0xed4245).setTimestamp()],
    });

    // InvalidRequest is the user's to fix (bad paste) — keep waiting. Others
    // need staff, so ping them.
    if (result.code !== 'InvalidRequest') {
      await channel.send({ content: `${staffPing} Ubisoft token gen failed for **${ticket.game.name}** — \`${result.code}\`. Manual handling needed.` });
      if (hg) {
        await logAction(hg, '⚠️ Ubisoft Token Failed', `**${ticket.game.name}** (appId \`${resolved.ubisoftAppId}\`) failed: \`${result.code}\` — ${result.error}\n\`\`\`\n${(result.logs || '').slice(-600)}\n\`\`\``, 0xed4245);
      }
    }
    return true;
  }

  // Success — build token.ini exactly as DenuvoTicket would.
  const tokenIni = `[token]\ntoken=${result.token}\nownership=${result.ownership}`;
  const iniBuffer = Buffer.from(tokenIni, 'utf8');
  const file = new AttachmentBuilder(iniBuffer, { name: 'token.ini' });

  const worksRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('works_yes').setLabel('Confirm Working').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('works_no').setLabel('Report Issue').setStyle(ButtonStyle.Danger),
  );

  const deliveryEmbed = new EmbedBuilder()
    .setTitle(`✅ ${ticket.game.name} — Token Ready`)
    .setDescription(
      `Here’s your \`token.ini\` for **${ticket.game.name}**.\n\n` +
        `**Last step:** drop \`token.ini\` into the same game folder where you put the magic files, then launch the game. Enjoy!`,
    )
    .setColor(0x57f287)
    .setTimestamp();

  const deliveryMsg = await channel.send({ embeds: [deliveryEmbed], files: [file], components: [worksRow] });
  await genMsg.delete().catch(() => {});
  await deliveryMsg.react('❤️').catch(() => {});

  await prisma.ticket.update({
    where: { id: ticket.id },
    data: { ubisoftStage: UBISOFT_STAGE_DONE, deliveryMessageId: deliveryMsg.id, staffId: client.user!.id } as any,
  });

  if (hg) {
    const via = result.accountId ? `account #${result.accountId}` : 'env default account';
    await logAction(hg, '🤖 Ubisoft Token Delivered', `Auto-minted + delivered token for **${ticket.game.name}** (appId \`${result.usedAppId}\`, via ${via}) in <#${channel.id}>.`, 0x57f287);
  }
  if (guildId) {
    await logTenant(guildId, '📦 Token Delivered', `A Ubisoft token for **${ticket.game.name}** was delivered to <@${ticket.userId}>.`, 0x57f287);
  }
  return true;
}

/** Convenience for staff commands: is the magic file present/servable? */
export function magicFileStatus(): { dir: string; present: string[]; missing: string[] } {
  const dir = (CONFIG.UBISOFT_MAGIC_DIR || '').trim();
  const present: string[] = [];
  const missing: string[] = [];
  if (!dir || !fs.existsSync(dir)) {
    return { dir, present, missing };
  }
  const files = new Set(fs.readdirSync(dir));
  for (const f of files) {
    if (catalogByMagicFile(f)) present.push(f);
  }
  return { dir, present, missing };
}
