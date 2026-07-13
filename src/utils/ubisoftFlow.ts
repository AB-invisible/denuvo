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
import { closeTicketForDailyLimit } from './ticketManager';
import { resolveUbisoftForGame, catalogByMagicFile, resolveMagicDir, catalogBySteamAppId, locateMagicZip, normalizeMagicFilename } from './ubisoftCatalog';
import { mintUbisoftToken, ubisoftServiceConfigured } from './ubisoftService';
import { resolvePublicBaseUrl } from './downloadHost';
import { createCallhomeInstaller } from './installerPackage';
import { isInstallerCallhomeEnabled } from './installerSettings';
import { consumeStock } from './gameManager';

export const UBISOFT_STAGE_AWAITING = 'AWAITING_TOKEN_REQ';
/** Call-home installer delivered — user should run installer.exe, not paste token_req. */
export const UBISOFT_STAGE_CALLHOME = 'AWAITING_CALLHOME';
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
/** Fallback: the original manual magic-zip flow (raw zip + paste token_req). */
async function startUbisoftManualDelivery(channel: TextChannel, ticket: any, guildId: string, staffPing: string): Promise<void> {
  const hg = homeGuild();
  const resolved = resolveUbisoftForGame(ticket.game)!;

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

export async function startUbisoftDelivery(channel: TextChannel, ticket: any, guild: Guild | null): Promise<void> {
  const guildId = ticket.guildId ?? guild?.id ?? '';
  const staffPing = await staffPingFor(guildId);
  const hg = homeGuild();

  const resolved = resolveUbisoftForGame(ticket.game);
  if (!resolved) {
    await channel.send({ content: `${staffPing} **${ticket.game.name}** is flagged Ubisoft but has no Ubisoft AppID configured. Set it with \`/ubisoftgame\`.` });
    return;
  }

  // Self-driving installer fetches magic files from /ubisoft/magic at runtime,
  // so we need a servable magic zip (self-hosted URL) plus a built installer.exe.
  // Fall back to the manual flow if any piece is missing.
  const delivery = resolveMagicDelivery(resolved.ubisoftAppId, resolved.magicFile, ticket.game.appId);
  const installer = (await isInstallerCallhomeEnabled('ubisoft')) && delivery?.url
    ? await createCallhomeInstaller({
        ticketId: ticket.id,
        guildId,
        gameName: ticket.game.name,
        appId: ticket.game.appId ?? null,
        layout: resolved.layout,
        platform: 'ubisoft',
        magicUrl: delivery.url,
        ubisoftAppId: resolved.ubisoftAppId,
        ubisoftAltAppId: resolved.ubisoftAltAppId,
        launchExe: resolved.launchExe,
      })
    : ({ ok: false, reason: 'no_base_url' } as const);

  if (!installer.ok) {
    await startUbisoftManualDelivery(channel, ticket, guildId, staffPing);
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
    data: { ubisoftStage: UBISOFT_STAGE_CALLHOME, screenshotVerified: true, staffId: client.user!.id } as any,
  });

  if (hg) {
    await logAction(hg, '🎮 Ubisoft Installer Delivered', `Self-driving installer for **${ticket.game.name}** (appId \`${resolved.ubisoftAppId}\`) delivered in <#${channel.id}>. Awaiting call-home.`, 0x5865f2);
  }
  if (guildId) {
    await logTenant(guildId, '🎮 Ubisoft Installer Delivered', `One-click installer for **${ticket.game.name}** delivered to <@${ticket.userId}>.`, 0x5865f2);
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
    const stage = (ticket as any).ubisoftStage as string | undefined;
    const callhomeRow = await prisma.tokenDownload.findFirst({
      where: {
        ticketId: ticket.id,
        platform: 'ubisoft',
        persistent: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    const onCallhome =
      (stage === UBISOFT_STAGE_CALLHOME || !!callhomeRow) && (await isInstallerCallhomeEnabled('ubisoft'));

    if (onCallhome) {
      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('⏳ Installer in progress')
            .setDescription(
              `You already have the **installer** — run **\`installer.exe\`** from the download link above if you have not yet.\n\n` +
                `It handles everything automatically. When it finishes, you will see **Activation Complete** here — **no need to attach \`token_req.txt\`.**\n\n` +
                `Only paste **\`token_req.txt\`** if the installer popup explicitly tells you to.`,
            )
            .setColor(0x5865f2),
        ],
      }).catch(() => {});
      return true;
    }

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
      const hadLocalQuota = (result.poolQuotaAtStart ?? 0) > 0;
      const title = hadLocalQuota ? '🔴 Activation Rejected by Ubisoft' : '🔴 Out of Tokens Today';
      const description = hadLocalQuota
        ? `**${ticket.game.name}** — Ubisoft reported the **daily activation limit** for our account, but our counter still shows activations available.\n\n` +
          `Staff has been notified to investigate (often a wrong AppID order or a counter sync issue). ` +
          `Fresh activations unlock at **00:00 UTC** if the limit was genuinely reached.\n\n` +
          `This ticket will close shortly. **No cooldown** will be applied — you can open a new ticket after activations reset.`
        : `**${ticket.game.name}** is **out of Ubisoft activations for today.** Fresh activations unlock at **00:00 UTC** — please try again tomorrow.\n\n` +
          `This ticket will close shortly. **No cooldown** will be applied — you can open a new ticket after activations reset.`;

      await genMsg.edit({
        embeds: [
          new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor(0xed4245)
            .setTimestamp(),
        ],
      });
      const appHint = result.usedAppId ? ` (AppID \`${result.usedAppId}\`)` : '';
      await channel.send({
        content: `${staffPing} Ubisoft daily activation limit reached for **${ticket.game.name}**${appHint}.`,
      }).catch(() => {});
      if (hg) {
        await logAction(
          hg,
          '⚠️ Ubisoft Activation Limit',
          `**${ticket.game.name}**${appHint} — ExceededActivations${hadLocalQuota ? ' (local quota remaining)' : ''} in <#${channel.id}>.\n\`\`\`\n${(result.logs || '').slice(-600)}\n\`\`\``,
          0xed4245,
        );
      }
      await closeTicketForDailyLimit(channel, ticket);
      return true;
    }

    const friendly =
      result.code === 'NotOwned'
        ? `Our Ubisoft account doesn’t own **${ticket.game.name}** on the configured AppID. Staff has been notified.`
        : result.code === 'InvalidRequest'
        ? `The submitted file could not be processed. Please launch **${ticket.game.name}** again and attach the updated **\`token_req.txt\`** to this ticket.`
        : result.code === 'LoginCooldown'
        ? `${result.error}\n\nJust re-attach your **\`token_req.txt\`** once the cooldown passes — no need to redo anything.`
        : result.code === 'LoginFailed'
        ? `Ubisoft sign-in is temporarily unavailable on our side. Staff has been notified — please try again in a few minutes.`
        : `Token generation failed. Staff has been notified.`;

    const isTransient = result.code === 'LoginCooldown';
    await genMsg.edit({
      embeds: [
        new EmbedBuilder()
          .setTitle(isTransient ? '⏳ Temporarily Unavailable' : '⚠️ Generation Failed')
          .setDescription(friendly)
          .setColor(isTransient ? 0xfee75c : 0xed4245)
          .setTimestamp(),
      ],
    });

    // InvalidRequest is the user's to fix (bad paste) — keep waiting. LoginCooldown
    // is a known transient back-off (staff already pinged on the first failure).
    // Everything else needs staff, so ping them.
    if (result.code !== 'InvalidRequest' && result.code !== 'LoginCooldown') {
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

  // Each successful Ubisoft mint is a real activation spent right now — decrement
  // stock at delivery, not on vouch (the vouch path skips Ubisoft/EA to avoid
  // double-counting). Otherwise delivered-but-unvouched tokens never drop the
  // count and the panel overstates availability.
  await consumeStock(ticket.gameId, guildId, !!ticket.fromQueue).catch((e) =>
    console.error('[UbisoftFlow] consumeStock failed:', (e as Error).message),
  );

  if (hg) {
    const via = result.accountId ? `account #${result.accountId}` : 'env default account';
    await logAction(hg, '🤖 Ubisoft Token Delivered', `Auto-minted + delivered token for **${ticket.game.name}** (appId \`${result.usedAppId}\`, via ${via}) in <#${channel.id}>.`, 0x57f287);
  }
  if (guildId) {
    await logTenant(guildId, '📦 Token Delivered', `A Ubisoft token for **${ticket.game.name}** was delivered to <@${ticket.userId}>.`, 0x57f287);
  }
  return true;
}

/**
 * Build a re-runnable staff TEST installer for a Ubisoft game (no ticket, no
 * real mint — /activate returns a placeholder token). Used by /installertest.
 */
export async function createUbisoftTestInstaller(
  game: any,
): Promise<{ ok: true; url: string; fileName: string } | { ok: false; message: string }> {
  const resolved = resolveUbisoftForGame(game);
  if (!resolved) return { ok: false, message: `**${game.name}** has no Ubisoft AppID configured (use \`/ubisoftgame\`).` };
  const delivery = resolveMagicDelivery(resolved.ubisoftAppId, resolved.magicFile, game.appId);
  if (!delivery?.url) {
    return { ok: false, message: `Magic zip for **${game.name}** isn't servable. Add it to \`UBISOFT_MAGIC_DIR\` and set \`PUBLIC_URL\`.` };
  }
  const r = await createCallhomeInstaller({
    ticketId: null,
    guildId: null,
    gameName: game.name,
    appId: game.appId ?? null,
    layout: resolved.layout,
    platform: 'ubisoft',
    magicUrl: delivery.url,
    ubisoftAppId: resolved.ubisoftAppId,
    ubisoftAltAppId: resolved.ubisoftAltAppId,
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
