/**
 * installerActivation.ts — server-side brain of the self-driving EA/Ubisoft
 * installer.
 *
 * When the installer has dropped the magic files, launched the game, captured
 * token_req.txt and killed the game, it POSTs token_req to
 * /activate/<installerKey>. That endpoint hands the work here: mint the token
 * (reusing the exact same mint clients as the manual ticket flow), write the
 * result back so the installer can drop token.ini into the game folder, and
 * finalize the Discord ticket (post the Confirm-Working / Report-Issue buttons,
 * flip the stage to DONE) — the same UI the manual paste-token_req path shows.
 */

import {
  TextChannel,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { client } from '../client';
import { logAction, logTenant } from './logging';
import { closeTicketForDailyLimit } from './ticketManager';
import { mintEaToken } from './eaService';
import { mintUbisoftToken } from './ubisoftService';
import { EA_STAGE_DONE, normalizeEaTicketInput } from './eaFlow';
import { UBISOFT_STAGE_DONE } from './ubisoftFlow';
import { consumeStockForTicket } from './gameManager';

export type ActivationPlatform = 'ea' | 'ubisoft';

/** The subset of the TokenDownload row the activation needs. */
export interface ActivationRow {
  token: string;
  installerKey: string | null;
  platform: string | null;
  appId: number | null;
  eaContentId: number | null;
  eaEngine: string | null;
  ubisoftAppId: number | null;
  ubisoftAltAppId: number | null;
  guildId: string | null;
  ticketId: number | null;
  fileName: string;
  persistent?: boolean; // staff test installer — placeholder token, no real mint
}

export interface ActivationOutcome {
  /** HTTP status the endpoint should return. */
  status: number;
  /** On success, the token.ini body the installer writes into the game folder. */
  tokenIni?: string;
  filename?: string;
  /** Machine code + human message surfaced to the installer on failure. */
  code?: string;
  message?: string;
  /** True once the row should be marked consumed (successful mint). */
  consume?: boolean;
}

function homeGuild() {
  return client.guilds.cache.get(CONFIG.GUILD_ID) ?? null;
}

/** Post the "activation complete — run the game" message with confirm buttons into the ticket channel. */
async function finalizeTicket(row: ActivationRow, gameName: string, platform: ActivationPlatform): Promise<void> {
  if (!row.ticketId) return;
  const ticket = await prisma.ticket.findUnique({ where: { id: row.ticketId }, include: { game: true } }).catch(() => null);
  if (!ticket) return;

  const channel = await client.channels.fetch(ticket.channelId).catch(() => null);
  if (!channel || !channel.isTextBased?.()) return;
  const textChannel = channel as TextChannel;

  const worksRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('works_yes').setLabel('Confirm Working').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('works_no').setLabel('Report Issue').setStyle(ButtonStyle.Danger),
  );

  const embed = new EmbedBuilder()
    .setTitle(`✅ ${gameName} — Activation Complete`)
    .setDescription(
      `Your activation file has been generated and **installed into your game folder automatically** by the installer.\n\n` +
        `**Final step:** launch **${gameName}** and confirm it works below.`,
    )
    .setColor(0x57f287)
    .setTimestamp();

  const msg = await textChannel.send({ embeds: [embed], components: [worksRow] }).catch(() => null);
  if (msg) await msg.react('❤️').catch(() => {});

  const stageField = platform === 'ea' ? { eaStage: EA_STAGE_DONE } : { ubisoftStage: UBISOFT_STAGE_DONE };
  await prisma.ticket.update({
    where: { id: ticket.id },
    data: { ...stageField, deliveryMessageId: msg?.id, staffId: client.user!.id } as any,
  }).catch(() => {});

  if (ticket.gameId) {
    await consumeStockForTicket(ticket, ticket.guildId || '').catch((e) =>
      console.error('[InstallerActivation] consumeStock failed:', (e as Error).message),
    );
  }

  const hg = homeGuild();
  if (hg) {
    await logAction(
      hg,
      '🤖 Installer Token Delivered',
      `Self-driving installer minted + placed the token for **${gameName}** (${platform}) in <#${ticket.channelId}>.`,
      0x57f287,
    );
  }
  if (ticket.guildId) {
    await logTenant(ticket.guildId, '📦 Token Delivered', `An installer-driven ${platform} token for **${gameName}** was delivered to <@${ticket.userId}>.`, 0x57f287);
  }
}

/** Notify staff + close the ticket when the platform reports the daily activation cap. */
async function handleExhausted(row: ActivationRow, gameName: string, logs?: string): Promise<void> {
  if (!row.ticketId) return;
  const ticket = await prisma.ticket.findUnique({ where: { id: row.ticketId }, include: { game: true } }).catch(() => null);
  if (!ticket) return;
  const channel = await client.channels.fetch(ticket.channelId).catch(() => null);
  const hg = homeGuild();
  if (hg) {
    await logAction(hg, '⚠️ Installer Activation Limit', `Daily activation cap hit for **${gameName}** via installer in <#${ticket.channelId}>.\n\`\`\`\n${(logs || '').slice(-500)}\n\`\`\``, 0xed4245);
  }
  if (channel && channel.isTextBased?.()) {
    await closeTicketForDailyLimit(channel as TextChannel, ticket).catch(() => {});
  }
}

/**
 * Mint the token for a call-home installer and finalize the ticket.
 * `row` is the already-looked-up, not-yet-consumed TokenDownload row.
 */
export async function processInstallerActivation(row: ActivationRow, tokenReq: string): Promise<ActivationOutcome> {
  const platform = (row.platform || '').toLowerCase() as ActivationPlatform;
  const gameName = (row.fileName || 'your game').replace(/^GameGen Activate\s*(\(TEST\)\s*)?/i, '').replace(/\.(zip|exe)$/i, '').trim() || 'your game';

  // Staff mechanics test: validate the whole pipeline (game find → install →
  // launch → token_req capture → write) WITHOUT minting a real token or
  // burning a daily activation. token_req just needs to be present.
  if (row.persistent) {
    if (!tokenReq || tokenReq.length < 20) {
      return { status: 422, code: 'InvalidRequest', message: 'Captured request looks empty — re-run the test.' };
    }
    return {
      status: 200,
      tokenIni: `[token]\ntoken=GAMEGEN_TEST_PLACEHOLDER\n; This is a staff mechanics test — not a real activation token.\n`,
      filename: 'token.ini',
      consume: false,
    };
  }

  if (platform === 'ea') {
    if (!row.eaContentId || !row.eaEngine) {
      return { status: 500, code: 'Misconfigured', message: 'This activation is missing its EA content id / engine. Contact staff.' };
    }
    const ticketLine = normalizeEaTicketInput(tokenReq);
    const result = await mintEaToken(ticketLine, row.eaContentId, row.eaEngine, row.guildId || '');
    if (result.ok) {
      await finalizeTicket(row, gameName, 'ea');
      return { status: 200, tokenIni: `[token]\ntoken=${result.token}\n`, filename: 'token.ini', consume: true };
    }
    if (result.code === 'LimitExceeded') {
      await handleExhausted(row, gameName, result.logs);
      return { status: 429, code: result.code, message: 'Out of activations for today. Fresh activations unlock at 00:00 UTC — try again tomorrow.' };
    }
    return mapMintFailure(result.code, result.error, gameName);
  }

  if (platform === 'ubisoft') {
    if (!row.ubisoftAppId) {
      return { status: 500, code: 'Misconfigured', message: 'This activation is missing its Ubisoft AppID. Contact staff.' };
    }
    const result = await mintUbisoftToken(row.ubisoftAppId, row.ubisoftAltAppId, tokenReq, row.guildId || '');
    if (result.ok) {
      await finalizeTicket(row, gameName, 'ubisoft');
      return { status: 200, tokenIni: `[token]\ntoken=${result.token}\nownership=${result.ownership}`, filename: 'token.ini', consume: true };
    }
    if (result.exhausted || result.code === 'ExceededActivations') {
      await handleExhausted(row, gameName, result.logs);
      return { status: 429, code: 'ExceededActivations', message: 'Out of activations for today. Fresh activations unlock at 00:00 UTC — try again tomorrow.' };
    }
    return mapMintFailure(result.code, result.error, gameName);
  }

  return { status: 400, code: 'UnknownPlatform', message: 'This installer is not associated with a supported platform.' };
}

/** Turn a service error code into an installer-facing outcome. InvalidRequest is retryable (don't consume). */
function mapMintFailure(code: string, error: string, gameName: string): ActivationOutcome {
  if (code === 'InvalidRequest') {
    // Bad / stale token_req — let the user re-run so the key stays usable.
    return { status: 422, code, message: 'The activation request could not be processed. Re-run the installer to try again.' };
  }
  const message =
    code === 'NotOwned' || code === 'NotEntitled'
      ? `Our account does not own ${gameName} on the configured ID. Staff has been notified.`
      : code === 'LoginFailed' || code === 'AuthError'
      ? 'The activation service could not sign in on our side. Staff has been notified.'
      : 'Token generation failed. Staff has been notified.';
  return { status: 502, code: code || 'Failure', message };
}
