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
import { resolveUbisoftForGame, catalogByMagicFile, resolveMagicDir, catalogBySteamAppId, locateMagicZip, normalizeMagicFilename } from './ubisoftCatalog';
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
  steamAppId?: number | null,
): { url?: string; localPath?: string; sizeMB?: number; resolvedFile?: string } | null {
  const base = resolvePublicBaseUrl();
  const dir = resolveMagicDir();
  const catalog = steamAppId ? catalogBySteamAppId(steamAppId) : undefined;

  const located = dir ? locateMagicZip(dir, magicFile, catalog) : null;
  let localPath: string | undefined;
  let sizeMB: number | undefined;
  let resolvedFile = magicFile ?? undefined;
  if (located) {
    localPath = located.path;
    resolvedFile = located.filename;
    sizeMB = fs.statSync(located.path).size / (1024 * 1024);
  }

  // Link is preferred (no Discord size limits, cacheable). Only valid if the
  // file is actually present for the payload server to stream.
  const url = base && localPath ? `${base}/ubisoft/magic/${ubisoftAppId}` : undefined;

  if (!url && !localPath) return null;
  return { url, localPath, sizeMB, resolvedFile };
}

function magicInstructions(gameName: string, layout: 'flat' | 'bin64'): string {
  const dropTarget =
    layout === 'bin64'
      ? 'the `Bin/Win64/` directory (extract the archive at your game root)'
      : 'your game directory, alongside the main executable';

  return (
    `**Install setup files**\n` +
    `Download the package above, extract it, and copy the contents into ${dropTarget}. Overwrite existing files if prompted.\n\n` +
    `**Generate request file**\n` +
    `Launch **${gameName}** once. The game will not load fully at this stage — this is expected. A file named **\`token_req.txt\`** will be created in your game directory.\n\n` +
    `**Submit for activation**\n` +
    `Attach **\`token_req.txt\`** to this ticket. Your activation file, **\`token.ini\`**, will be delivered here once processing is complete.`
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

  const delivery = resolveMagicDelivery(resolved.ubisoftAppId, resolved.magicFile, ticket.game.appId);
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
    .setTitle(`🎮 ${ticket.game.name} — Activation Setup`)
    .setDescription(
      `Your screenshot has been verified. Please complete the steps below to proceed with activation.\n\n` +
        magicInstructions(ticket.game.name, resolved.layout),
    )
    .setColor(0x5865f2)
    .setFooter({ text: 'Awaiting token_req.txt' })
    .setTimestamp();

  if (delivery.url) {
    embed.addFields({ name: '📦 Setup Package', value: `[Download here](${delivery.url})` });
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
  const attach = message.attachments.find((a) => {
    const name = (a.name || '').toLowerCase();
    return name === 'token_req.txt' || name.endsWith('.txt') || name.endsWith('.ini') || (a.contentType || '').startsWith('text/');
  });
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
          .setTitle('📎 Activation file required')
          .setDescription(
            `Please attach **\`token_req.txt\`** to this ticket to continue.\n\n` +
              `This file is generated in your game directory after installing the setup files and launching **${ticket.game.name}** once.`,
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
        .setTitle('⚙️ Processing activation request')
        .setDescription(`Generating your activation file for **${ticket.game.name}**. This may take up to one minute.`)
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
        ? `The submitted file could not be processed. Please launch **${ticket.game.name}** again and attach the updated **\`token_req.txt\`** to this ticket.`
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
    .setTitle(`✅ ${ticket.game.name} — Activation Complete`)
    .setDescription(
      `Your **\`token.ini\`** for **${ticket.game.name}** is ready.\n\n` +
        `**Final step:** place **\`token.ini\`** in the same game directory where you installed the setup files, then launch the game.`,
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
  const dir = resolveMagicDir();
  const present: string[] = [];
  const missing: string[] = [];
  if (!dir || !fs.existsSync(dir)) {
    return { dir, present, missing };
  }
  const files = new Set(fs.readdirSync(dir));
  for (const f of files) {
    if (catalogByMagicFile(f) || catalogByMagicFile(normalizeMagicFilename(f))) present.push(f);
  }
  return { dir, present, missing };
}
