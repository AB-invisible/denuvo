/**
 * eaFlow.ts — two-step EA / Origin Denuvo delivery flow.
 *
 *   1. Screenshot verifies (same as Steam).
 *   2. startEaDelivery(): magic files + instructions → eaStage = AWAITING_TICKET.
 *   3. User runs game → Denuvo ticket (often in token_req.txt).
 *   4. handleEaTicket(): POST to ea-service → deliver token.ini.
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
import { closeTicketForDailyLimit } from './ticketManager';
import {
  resolveEaForGame,
  catalogByMagicFile,
  resolveMagicDir,
  catalogBySteamAppId,
  locateMagicZip,
  normalizeMagicFilename,
} from './eaCatalog';
import { mintEaToken, eaServiceConfigured } from './eaService';
import { resolvePublicBaseUrl } from './downloadHost';

export const EA_STAGE_AWAITING = 'AWAITING_TICKET';
export const EA_STAGE_DONE = 'DONE';

const TICKET_FULL_RE =
  /^((?:[A-Za-z0-9_\-]{4}){40,}(?:[A-Za-z0-9_\-]{2}==|[A-Za-z0-9_\-]{3}=)?)\|(\d+)\|([a-zA-Z_\d]+)$/;
const TICKET_BLOB_RE = /[A-Za-z0-9+/=_\-]{40,}/;
const TICKET_MIN_LEN = 40;

function homeGuild() {
  return client.guilds.cache.get(CONFIG.GUILD_ID) ?? null;
}

async function staffPingFor(guildId: string): Promise<string> {
  const sc = await (await import('./tenant')).resolveServerConfig(guildId);
  return sc.staffPing;
}

function resolveMagicDelivery(
  eaContentId: number,
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

  const url = base && localPath ? `${base}/ea/magic/${eaContentId}` : undefined;
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
    `**Generate activation ticket**\n` +
    `Launch **${gameName}** once. The game will not load fully at this stage — this is expected. A file named **\`token_req.txt\`** (or similar ticket file) will be created in your game directory.\n\n` +
    `**Submit for activation**\n` +
    `Attach **\`token_req.txt\`** to this ticket. Your activation file, **\`token.ini\`**, will be delivered here once processing is complete.`
  );
}

export async function startEaDelivery(channel: TextChannel, ticket: any, guild: Guild | null): Promise<void> {
  const guildId = ticket.guildId ?? guild?.id ?? '';
  const staffPing = await staffPingFor(guildId);
  const hg = homeGuild();

  const resolved = resolveEaForGame(ticket.game);
  if (!resolved) {
    await channel.send({
      content: `${staffPing} **${ticket.game.name}** is flagged EA but has no content ID / engine configured. Set it with \`/eagame\`.`,
    });
    return;
  }

  const delivery = resolveMagicDelivery(resolved.eaContentId, resolved.magicFile, ticket.game.appId);
  if (!delivery) {
    await channel.send({
      content:
        `${staffPing} Screenshot verified for **${ticket.game.name}**, but the setup zip ` +
        `(\`${resolved.magicFile ?? 'unknown'}\`) isn't available. Upload it to \`EA_MAGIC_DIR\` or set \`PUBLIC_URL\`. Manual delivery needed.`,
    });
    if (hg) {
      await logAction(
        hg,
        '⚠️ EA Magic Files Missing',
        `No setup zip for **${ticket.game.name}** (contentId \`${resolved.eaContentId}\`) in <#${channel.id}>.`,
        0xed4245,
      );
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
    .setFooter({ text: 'Awaiting Denuvo ticket' })
    .setTimestamp();

  if (delivery.url) {
    embed.addFields({ name: '📦 Setup Package', value: `[Download here](${delivery.url})` });
  }

  const files: AttachmentBuilder[] = [];
  if (delivery.localPath && (delivery.sizeMB ?? 99) <= 24) {
    files.push(new AttachmentBuilder(delivery.localPath, { name: path.basename(delivery.localPath) }));
  }

  await channel.send({ embeds: [embed], ...(files.length ? { files } : {}) });

  await prisma.ticket.update({
    where: { id: ticket.id },
    data: { eaStage: EA_STAGE_AWAITING, screenshotVerified: true, staffId: client.user!.id } as any,
  });

  if (hg) {
    await logAction(
      hg,
      '🎮 EA Setup Delivered',
      `Delivered setup files for **${ticket.game.name}** (contentId \`${resolved.eaContentId}\`) in <#${channel.id}>. Awaiting ticket.`,
      0x5865f2,
    );
  }
  if (guildId) {
    await logTenant(guildId, '🎮 EA Setup Delivered', `Setup files for **${ticket.game.name}** delivered to <@${ticket.userId}>. Awaiting ticket.`, 0x5865f2);
  }
}

export async function extractEaTicket(
  message: Message,
  contentId: number,
  engine: string,
): Promise<{ ticket: string; contentId: number; engine: string } | null> {
  const readText = async (url: string) => {
    const res = await fetch(url);
    return (await res.text()).trim().replace(/\r/g, '');
  };

  const attach = message.attachments.find((a) => {
    const name = (a.name || '').toLowerCase();
    return name === 'token_req.txt' || name.endsWith('.txt') || name.endsWith('.ini') || (a.contentType || '').startsWith('text/');
  });

  const candidates: string[] = [];
  if (attach) {
    try {
      candidates.push(await readText(attach.url));
    } catch {
      /* fall through */
    }
  }

  const body = (message.content || '').trim().replace(/```[a-z]*\n?|```/gi, '').trim();
  if (body) candidates.push(body);

  for (const raw of candidates) {
    const line = raw.split('\n').map((l) => l.trim()).find((l) => l.length >= TICKET_MIN_LEN) || raw.replace(/\s+/g, '');
    const full = line.match(TICKET_FULL_RE);
    if (full) {
      let cid = Number(full[2]);
      let eng = full[3];
      // FC 26 (and similar) emit TICKET|0|<contentId> instead of TICKET|<contentId>|<engine>.
      if (cid === 0 && /^\d+$/.test(eng)) {
        cid = Number(eng);
        eng = '0';
      }
      return { ticket: full[0], contentId: cid, engine: eng };
    }
    const blob = line.match(TICKET_BLOB_RE);
    if (blob && blob[0].length >= TICKET_MIN_LEN) {
      return { ticket: blob[0], contentId, engine };
    }
    if (line.length >= TICKET_MIN_LEN && !/\s/.test(line)) {
      return { ticket: line, contentId, engine };
    }
  }
  return null;
}

export async function handleEaTicket(message: Message, ticket: any): Promise<boolean> {
  const channel = message.channel as TextChannel;
  const guildId = ticket.guildId ?? message.guildId ?? '';
  const staffPing = await staffPingFor(guildId);
  const hg = homeGuild();

  const resolved = resolveEaForGame(ticket.game);
  if (!resolved) {
    await channel.send({ content: `${staffPing} **${ticket.game.name}** has no EA content ID / engine configured. Set it with \`/eagame\`.` });
    return true;
  }

  const parsed = await extractEaTicket(message, resolved.eaContentId, resolved.eaEngine);
  if (!parsed) {
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('📎 Activation ticket required')
          .setDescription(
            `Please attach **\`token_req.txt\`** to this ticket to continue.\n\n` +
              `This file is generated after installing the setup files and launching **${ticket.game.name}** once.`,
          )
          .setColor(0xfee75c),
      ],
    }).catch(() => {});
    return true;
  }

  if (!eaServiceConfigured()) {
    await channel.send({
      content: `${staffPing} EA token service isn't configured (\`EA_SERVICE_URL\`/\`EA_SERVICE_KEY\`). Manual delivery needed for **${ticket.game.name}**.`,
    });
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

  const result = await mintEaToken(parsed.ticket, parsed.contentId, parsed.engine);

  if (!result.ok) {
    if (result.code === 'LimitExceeded') {
      const description =
        `**${ticket.game.name}** is **out of EA activations for today.** Fresh activations unlock at **00:00 UTC** — please try again tomorrow.\n\n` +
        `This ticket will close shortly. **No cooldown** will be applied — you can open a new ticket after activations reset.`;

      await genMsg.edit({
        embeds: [new EmbedBuilder().setTitle('🔴 Out of Tokens Today').setDescription(description).setColor(0xed4245).setTimestamp()],
      });
      await channel.send({
        content: `${staffPing} EA daily activation limit reached for **${ticket.game.name}** (contentId \`${parsed.contentId}\`).`,
      }).catch(() => {});
      if (hg) {
        await logAction(
          hg,
          '⚠️ EA Activation Limit',
          `**${ticket.game.name}** (contentId \`${parsed.contentId}\`) — LimitExceeded in <#${channel.id}>.\n\`\`\`\n${(result.logs || '').slice(-600)}\n\`\`\``,
          0xed4245,
        );
      }
      await closeTicketForDailyLimit(channel, ticket);
      return true;
    }

    const friendly =
      result.code === 'NotEntitled'
        ? `Our EA account doesn't own **${ticket.game.name}** on content ID \`${parsed.contentId}\`. Staff has been notified.`
        : result.code === 'InvalidRequest'
        ? `The submitted file could not be processed. Please launch **${ticket.game.name}** again and attach the updated **\`token_req.txt\`**.`
        : result.code === 'AuthError'
        ? `EA login failed on our side. Staff has been notified — session cookies may need refreshing.`
        : `Token generation failed. Staff has been notified.`;

    await genMsg.edit({
      embeds: [new EmbedBuilder().setTitle('⚠️ Generation Failed').setDescription(friendly).setColor(0xed4245).setTimestamp()],
    });

    if (result.code !== 'InvalidRequest') {
      await channel.send({ content: `${staffPing} EA token gen failed for **${ticket.game.name}** — \`${result.code}\`. Manual handling needed.` });
      if (hg) {
        await logAction(
          hg,
          '⚠️ EA Token Failed',
          `**${ticket.game.name}** (contentId \`${parsed.contentId}\`) failed: \`${result.code}\` — ${result.error}\n\`\`\`\n${(result.logs || '').slice(-600)}\n\`\`\``,
          0xed4245,
        );
      }
    }
    return true;
  }

  const tokenIni = `[token]\ntoken=${result.token}\n`;
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
    data: { eaStage: EA_STAGE_DONE, deliveryMessageId: deliveryMsg.id, staffId: client.user!.id } as any,
  });

  if (hg) {
    await logAction(
      hg,
      '🤖 EA Token Delivered',
      `Auto-minted + delivered token for **${ticket.game.name}** (contentId \`${result.usedContentId}\`, engine \`${result.usedEngine}\`) in <#${channel.id}>.`,
      0x57f287,
    );
  }
  if (guildId) {
    await logTenant(guildId, '📦 Token Delivered', `An EA token for **${ticket.game.name}** was delivered to <@${ticket.userId}>.`, 0x57f287);
  }
  return true;
}

export function eaMagicFileStatus(): { dir: string; present: string[] } {
  const dir = resolveMagicDir();
  const present: string[] = [];
  if (!dir || !fs.existsSync(dir)) return { dir, present };
  for (const f of fs.readdirSync(dir)) {
    if (catalogByMagicFile(f) || catalogByMagicFile(normalizeMagicFilename(f))) present.push(f);
  }
  return { dir, present };
}
