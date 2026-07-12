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
  EA_CATALOG,
} from './eaCatalog';
import { mintEaToken, eaServiceConfigured } from './eaService';
import { resolvePublicBaseUrl } from './downloadHost';
import { createCallhomeInstaller } from './installerPackage';
import { consumeStock } from './gameManager';

export const EA_STAGE_AWAITING = 'AWAITING_TICKET';
/** Call-home installer delivered — user should run installer.exe, not paste ticket. */
export const EA_STAGE_CALLHOME = 'AWAITING_CALLHOME';
export const EA_STAGE_DONE = 'DONE';

const TICKET_FULL_RE =
  /^((?:[A-Za-z0-9+\/_\-]{4}){40,}(?:[A-Za-z0-9+\/_\-]{2}==|[A-Za-z0-9+\/_\-]{3}=)?)\|(\d+)\|([a-zA-Z_\d]+)$/;
const TICKET_PIPE_TAIL_RE = /\|[0-9]+\|[0-9a-zA-Z_]+\s*$/;
const TICKET_BLOB_RE = /[A-Za-z0-9+/=_\-]{40,}/;
const TICKET_MIN_LEN = 40;

/** Pull the pipe-separated Denuvo line out of a multi-line Denuvo_ticket_*.txt file. */
export function normalizeEaTicketInput(raw: string): string {
  const text = (raw || '').trim().replace(/\r/g, '');
  if (!text) return '';

  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (TICKET_FULL_RE.test(line)) return line;
    if (line.length >= TICKET_MIN_LEN && TICKET_PIPE_TAIL_RE.test(line)) return line;
  }

  const flat = text.replace(/\s+/g, '');
  if (TICKET_FULL_RE.test(flat)) return flat.match(TICKET_FULL_RE)![0];
  return text;
}

function parseEaTicketLine(line: string, contentId: number, engine: string): { ticket: string; contentId: number; engine: string } | null {
  const full = line.match(TICKET_FULL_RE);
  if (full) {
    let cid = Number(full[2]);
    let eng = full[3];
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
  return null;
}

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
  magicUrl?: string | null,
): { url?: string; localPath?: string; sizeMB?: number; resolvedFile?: string } | null {
  const base = resolvePublicBaseUrl();
  const dir = resolveMagicDir();
  const catalog = steamAppId ? catalogBySteamAppId(steamAppId) : undefined;
  const externalUrl = magicUrl ?? catalog?.eaMagicUrl ?? null;

  const located = dir ? locateMagicZip(dir, magicFile, catalog) : null;
  let localPath: string | undefined;
  let sizeMB: number | undefined;
  let resolvedFile = magicFile ?? catalog?.eaMagicFile ?? undefined;
  if (located) {
    localPath = located.path;
    resolvedFile = located.filename;
    sizeMB = fs.statSync(located.path).size / (1024 * 1024);
  }

  const selfHostedUrl = base && localPath ? `${base}/ea/magic/${eaContentId}` : undefined;
  const url = selfHostedUrl ?? externalUrl ?? undefined;
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
    `Launch **${gameName}** once. The game will not load fully at this stage — this is expected. A file named **\`Denuvo_ticket_*.txt\`** (or **\`token_req.txt\`**) will be created in your game directory.\n\n` +
    `**Submit for activation**\n` +
    `Attach that ticket file to this channel. Your activation file, **\`token.ini\`**, will be delivered here once processing is complete.`
  );
}

export type EaMagicSendResult =
  | { ok: true; url?: string; localPath?: string; sizeMB?: number; resolvedFile?: string }
  | { ok: false; reason: 'not_ea' | 'missing_zip'; message: string };

/** Post the EA setup zip embed (and attachment when small enough) to a channel. */
export async function sendEaMagicPackage(
  channel: TextChannel,
  game: { name: string; appId?: number | null; eaContentId?: number | null; eaEngine?: string | null; eaMagicFile?: string | null },
  options?: { test?: boolean },
): Promise<EaMagicSendResult> {
  const resolved = resolveEaForGame(game);
  if (!resolved) {
    return {
      ok: false,
      reason: 'not_ea',
      message: `**${game.name}** is not configured as an EA title. Use \`/eagame set\` first.`,
    };
  }

  const delivery = resolveMagicDelivery(resolved.eaContentId, resolved.magicFile, game.appId, resolved.magicUrl);
  if (!delivery) {
    return {
      ok: false,
      reason: 'missing_zip',
      message:
        `Setup zip \`${resolved.magicFile ?? 'unknown'}\` is not available. ` +
        `Upload it to \`EA_MAGIC_DIR\`, add a catalog URL, or set \`PUBLIC_URL\`.`,
    };
  }

  const testBanner = options?.test
    ? `🧪 **Staff test delivery** — same package users get after screenshot verification.\n\n`
    : `Your screenshot has been verified. Please complete the steps below to proceed with activation.\n\n`;

  const embed = new EmbedBuilder()
    .setTitle(`🎮 ${game.name} — Activation Setup${options?.test ? ' (Test)' : ''}`)
    .setDescription(testBanner + magicInstructions(game.name, resolved.layout))
    .setColor(options?.test ? 0xfee75c : 0x5865f2)
    .setFooter({ text: options?.test ? 'EA magic files test' : 'Awaiting Denuvo ticket' })
    .setTimestamp();

  if (delivery.url) {
    const sizeHint = delivery.sizeMB ? ` (~${delivery.sizeMB.toFixed(1)} MB)` : '';
    embed.addFields({ name: '📦 Setup Package', value: `[Download here](${delivery.url})${sizeHint}` });
  }

  const files: AttachmentBuilder[] = [];
  if (delivery.localPath && (delivery.sizeMB ?? 99) <= 24) {
    files.push(new AttachmentBuilder(delivery.localPath, { name: path.basename(delivery.localPath) }));
  }

  await channel.send({ embeds: [embed], ...(files.length ? { files } : {}) });
  return { ok: true, ...delivery };
}

/** Fallback to the original manual magic-zip flow (raw zip + paste token_req). */
async function startEaManualDelivery(channel: TextChannel, ticket: any, guildId: string, staffPing: string): Promise<void> {
  const hg = homeGuild();
  const result = await sendEaMagicPackage(channel, ticket.game);
  if (!result.ok) {
    const prefix = result.reason === 'not_ea' ? staffPing : `${staffPing} Screenshot verified for **${ticket.game.name}**, but the`;
    await channel.send({
      content:
        result.reason === 'missing_zip'
          ? `${prefix} setup zip (\`${ticket.game.eaMagicFile ?? 'unknown'}\`) isn't available. Upload it to \`EA_MAGIC_DIR\`, add a catalog URL, or set \`PUBLIC_URL\`. Manual delivery needed.`
          : `${staffPing} ${result.message}`,
    });
    if (result.reason === 'missing_zip' && hg) {
      const resolved = resolveEaForGame(ticket.game);
      await logAction(hg, '⚠️ EA Magic Files Missing', `No setup zip for **${ticket.game.name}** (contentId \`${resolved?.eaContentId ?? '?'}\`) in <#${channel.id}>.`, 0xed4245);
    }
    return;
  }
  await prisma.ticket.update({
    where: { id: ticket.id },
    data: { eaStage: EA_STAGE_AWAITING, screenshotVerified: true, staffId: client.user!.id } as any,
  });
}

export async function startEaDelivery(channel: TextChannel, ticket: any, guild: Guild | null): Promise<void> {
  const guildId = ticket.guildId ?? guild?.id ?? '';
  const staffPing = await staffPingFor(guildId);
  const hg = homeGuild();

  const resolved = resolveEaForGame(ticket.game);
  if (!resolved) {
    await channel.send({ content: `${staffPing} **${ticket.game.name}** is not configured as an EA title. Use \`/eagame set\` first.` });
    return;
  }

  // The self-driving installer fetches the setup files from /ea/magic at
  // runtime, so we need the magic zip servable (self-hosted URL) plus a built
  // installer.exe. If any piece is missing, fall back to the manual flow.
  const delivery = resolveMagicDelivery(resolved.eaContentId, resolved.magicFile, ticket.game.appId, resolved.magicUrl);
  const installer = CONFIG.INSTALLER_CALLHOME && delivery?.url
    ? await createCallhomeInstaller({
        ticketId: ticket.id,
        guildId,
        gameName: ticket.game.name,
        appId: ticket.game.appId ?? null,
        layout: resolved.layout,
        platform: 'ea',
        magicUrl: delivery.url,
        eaContentId: resolved.eaContentId,
        eaEngine: resolved.eaEngine,
        tokenReqNames: resolved.tokenReqNames,
        launchExe: resolved.launchExe,
      })
    : ({ ok: false, reason: 'no_base_url' } as const);

  if (!installer.ok) {
    await startEaManualDelivery(channel, ticket, guildId, staffPing);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`✅ ${ticket.game.name} — Get Activated`)
    .setDescription(
      `Your screenshot is verified. **Do these 3 steps:**\n\n` +
        `**1️⃣  Download** the file below.\n` +
        `**2️⃣  Extract** the ZIP  →  right-click it, pick **Extract All**.\n` +
        `**3️⃣  Run** the **\`installer.exe\`** inside the extracted folder.\n\n` +
        `That's it. The installer does **everything else by itself** — no clicking, no pasting.\n\n` +
        `⚠️  **${ticket.game.name} must already be installed on Steam.**\n\n` +
        `When it finishes, **launch the game** and press **Confirm Working** below. ❤️`,
    )
    .setColor(0x57f287)
    .addFields({ name: '⬇️ Download', value: `**[⬇️  CLICK HERE TO DOWNLOAD](${installer.url})**` })
    .setFooter({ text: '① Download  ②  Extract the ZIP  ③  Run installer.exe  •  Link valid 3 hours' })
    .setTimestamp();

  await channel.send({ embeds: [embed] });

  await prisma.ticket.update({
    where: { id: ticket.id },
    data: { eaStage: EA_STAGE_CALLHOME, screenshotVerified: true, staffId: client.user!.id } as any,
  });

  if (hg) {
    await logAction(hg, '🎮 EA Installer Delivered', `Self-driving installer for **${ticket.game.name}** (contentId \`${resolved.eaContentId}\`) delivered in <#${channel.id}>. Awaiting call-home.`, 0x5865f2);
  }
  if (guildId) {
    await logTenant(guildId, '🎮 EA Installer Delivered', `One-click installer for **${ticket.game.name}** delivered to <@${ticket.userId}>.`, 0x5865f2);
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
    const line = normalizeEaTicketInput(raw);
    if (!line) continue;
    const parsed = parseEaTicketLine(line, contentId, engine);
    if (parsed) return parsed;
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
    const stage = (ticket as any).eaStage as string | undefined;
    const callhomeRow = await prisma.tokenDownload.findFirst({
      where: {
        ticketId: ticket.id,
        platform: 'ea',
        persistent: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    const onCallhome = stage === EA_STAGE_CALLHOME || !!callhomeRow;

    if (onCallhome) {
      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('⏳ Installer in progress')
            .setDescription(
              `Run **\`installer.exe\`** from the download link above if you have not yet.\n\n` +
                `It handles everything automatically. When it finishes, you will see **Activation Complete** here — **no need to attach ticket files.**\n\n` +
                `Only paste a ticket file if the installer popup explicitly tells you to.`,
            )
            .setColor(0x5865f2),
        ],
      }).catch(() => {});
      return true;
    }

    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('📎 Activation ticket required')
          .setDescription(
            `Please attach your **Denuvo ticket file** (\`Denuvo_ticket_*.txt\` or \`token_req.txt\`) to continue.\n\n` +
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

  const result = await mintEaToken(parsed.ticket, parsed.contentId, parsed.engine, guildId);

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
        : result.code === 'EmailCodePending'
        ? `Our EA account needs a quick one-time verification. Staff has been notified — it'll be sorted in a minute, then just resubmit your **\`token_req.txt\`**.`
        : result.code === 'AuthError'
        ? `EA login failed on our side. Staff has been notified — session cookies may need refreshing.`
        : `Token generation failed. Staff has been notified.`;

    await genMsg.edit({
      embeds: [new EmbedBuilder().setTitle('⚠️ Generation Failed').setDescription(friendly).setColor(0xed4245).setTimestamp()],
    });

    if (result.code !== 'InvalidRequest') {
      const ping =
        result.code === 'EmailCodePending'
          ? `${staffPing} EA emailed a verification code for our account. Run \`/eacode code:<digits>\` (check the inbox), then have <@${ticket.userId}> resubmit their \`token_req.txt\`.`
          : `${staffPing} EA token gen failed for **${ticket.game.name}** — \`${result.code}\`. Manual handling needed.`;
      await channel.send({ content: ping });
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

  // Each EA mint is a real activation spent now — decrement stock at delivery,
  // not on vouch (the vouch path skips EA/Ubisoft to avoid double-counting).
  await consumeStock(ticket.gameId, guildId, !!ticket.fromQueue).catch((e) =>
    console.error('[EaFlow] consumeStock failed:', (e as Error).message),
  );

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

/**
 * Build a re-runnable staff TEST installer for an EA game (no ticket, no real
 * mint — /activate returns a placeholder token). Used by /installertest.
 */
export async function createEaTestInstaller(
  game: any,
): Promise<{ ok: true; url: string; fileName: string } | { ok: false; message: string }> {
  const resolved = resolveEaForGame(game);
  if (!resolved) return { ok: false, message: `**${game.name}** is not configured as an EA title (use \`/eagame set\`).` };
  const delivery = resolveMagicDelivery(resolved.eaContentId, resolved.magicFile, game.appId, resolved.magicUrl);
  if (!delivery?.url) {
    return { ok: false, message: `Setup zip for **${game.name}** isn't servable. Add it to \`EA_MAGIC_DIR\` (or a catalog URL) and set \`PUBLIC_URL\`.` };
  }
  const r = await createCallhomeInstaller({
    ticketId: null,
    guildId: null,
    gameName: game.name,
    appId: game.appId ?? null,
    layout: resolved.layout,
    platform: 'ea',
    magicUrl: delivery.url,
    eaContentId: resolved.eaContentId,
    eaEngine: resolved.eaEngine,
    tokenReqNames: resolved.tokenReqNames,
    launchExe: resolved.launchExe,
    test: true,
  });
  if (!r.ok) {
    return {
      ok: false,
      message: r.reason === 'no_base_url'
        ? '`PUBLIC_URL` / `RAILWAY_PUBLIC_DOMAIN` is not set — cannot host the installer.'
        : '`_Core/installer.exe` is not built yet.',
    };
  }
  return { ok: true, url: r.url, fileName: r.fileName };
}

export function eaMagicFileStatus(): { dir: string; present: string[]; external: string[] } {
  const dir = resolveMagicDir();
  const present: string[] = [];
  const external: string[] = [];
  if (dir && fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.zip')) continue;
      if (catalogByMagicFile(f) || catalogByMagicFile(normalizeMagicFilename(f))) present.push(f);
    }
  }
  for (const entry of EA_CATALOG) {
    if (entry.eaMagicUrl && entry.eaMagicFile) external.push(`${entry.eaMagicFile} (external URL)`);
  }
  return { dir, present, external };
}
