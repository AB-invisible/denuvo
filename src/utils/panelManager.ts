import { client } from '../client';
import { CONFIG } from '../config';
import {
  TextChannel,
  AttachmentBuilder,
  TextBasedChannel,
  Message,
  MessageEditOptions,
  EmbedBuilder,
} from 'discord.js';
import { createMainPanel } from './embeds';
import { logAction } from './logging';
import { getPanelAssetUrl, panelImageAttachmentPath } from './downloadHost';
import prisma from '../lib/prisma';

const PANEL_EDIT_DELAY_MS = 500;
const PANEL_REFRESH_DEBOUNCE_MS = 2500;

let panelRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let panelRefreshInFlight = false;
let panelRefreshQueued = false;

function isStaleDiscordResource(err: unknown): boolean {
  const e = err as { code?: number; status?: number };
  return e?.code === 10003 || e?.code === 10008 || e?.status === 404;
}

function isDiscord500(err: unknown): boolean {
  return (err as { status?: number }).status === 500;
}

function logDiscordApiError(context: string, err: unknown): void {
  const raw = (err as { rawError?: unknown }).rawError;
  if (raw) console.error(`[Panel] ${context} Discord API error:`, JSON.stringify(raw));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Keep the image URL already on the message so refresh edits don't re-upload or swap CDN hosts. */
function embedsForPanelRefresh(message: Message, embeds: EmbedBuilder[]): EmbedBuilder[] {
  if (embeds.length === 0) return embeds;

  const existingImageUrl = message.embeds[0]?.image?.url;
  const embed = EmbedBuilder.from(embeds[0]);

  if (existingImageUrl) {
    embed.setImage(existingImageUrl);
    return [embed];
  }

  const hostedUrl = getPanelAssetUrl('gamegen.png');
  if (hostedUrl) {
    embed.setImage(hostedUrl);
  }

  return [embed];
}

function buildPanelEditPayload(
  message: Message,
  panelContent: Awaited<ReturnType<typeof createMainPanel>>,
  opts?: { stripImage?: boolean },
): MessageEditOptions {
  const usesHostedImage = !!getPanelAssetUrl('gamegen.png');
  const hasLegacyAttachment = message.attachments.some((a) => a.name === 'gamegen.png');

  let embeds = embedsForPanelRefresh(message, panelContent.embeds);
  if (opts?.stripImage && embeds.length > 0) {
    embeds = [EmbedBuilder.from(embeds[0]).setImage(null)];
  }

  const payload: MessageEditOptions = {
    embeds,
    components: panelContent.components,
  };

  // Legacy panels uploaded gamegen.png as a file. Strip it once we serve the
  // banner from a URL — leaving both attached causes Discord edit 500s.
  if (usesHostedImage && hasLegacyAttachment) {
    payload.attachments = [];
  } else if (!usesHostedImage && !hasLegacyAttachment) {
    payload.files = [new AttachmentBuilder(panelImageAttachmentPath('gamegen.png'), { name: 'gamegen.png' })];
  }

  return payload;
}

async function editMessageWithRetry(message: Message, payload: MessageEditOptions, retries = 3): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await message.edit(payload);
      return;
    } catch (err) {
      if (isStaleDiscordResource(err)) throw err;
      if (isDiscord500(err) && attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      logDiscordApiError('edit', err);
      throw err;
    }
  }
}

async function editPanelMessage(
  message: Message,
  panelContent: Awaited<ReturnType<typeof createMainPanel>>,
): Promise<void> {
  try {
    await editMessageWithRetry(message, buildPanelEditPayload(message, panelContent));
    return;
  } catch (err) {
    if (!isDiscord500(err)) throw err;
    console.warn(`[Panel] Full edit failed for ${message.id}, retrying without embed image…`);
  }

  try {
    await editMessageWithRetry(message, buildPanelEditPayload(message, panelContent, { stripImage: true }));
    return;
  } catch (err) {
    if (!isDiscord500(err)) throw err;
    console.warn(`[Panel] Imageless edit failed for ${message.id}, retrying components-only…`);
  }

  await editMessageWithRetry(message, {
    components: panelContent.components,
    attachments: [],
  });
}

export async function sendMessageWithRetry(
  channel: TextChannel,
  payload: Parameters<TextChannel['send']>[0],
  retries = 3,
): Promise<Message> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await channel.send(payload);
    } catch (err) {
      if (isStaleDiscordResource(err)) throw err;
      if (isDiscord500(err) && attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      logDiscordApiError('send', err);
      throw err;
    }
  }
  throw new Error('sendMessageWithRetry exhausted retries');
}

/**
 * Refreshes all active game selection panels in the guild.
 */
async function refreshAllPanelsNow() {
  try {
    const panels = await prisma.panel.findMany();

    // Group panels by guild to avoid regenerating the same content per-guild
    const guildPanels = new Map<string, typeof panels>();
    for (const panel of panels) {
      try {
        const channel = await client.channels.fetch(panel.channelId).catch(() => null);
        if (!channel || !(channel instanceof TextChannel)) {
          await prisma.panel.delete({ where: { id: panel.id } }).catch(() => {});
          continue;
        }
        const gid = channel.guildId || '';
        if (!guildPanels.has(gid)) guildPanels.set(gid, []);
        guildPanels.get(gid)!.push(panel);
      } catch (err) {
        if (isStaleDiscordResource(err)) {
          await prisma.panel.delete({ where: { id: panel.id } }).catch(() => {});
        }
      }
    }

    // Generate per-guild panel content and update sequentially — parallel
    // PATCHes across channels often trigger transient Discord 500s.
    for (const [guildId, guildPanelList] of guildPanels) {
      const panelContent = await createMainPanel(guildId);

      for (const panelRecord of guildPanelList) {
        try {
          const channel = await client.channels.fetch(panelRecord.channelId).catch(() => null);
          if (!channel || !(channel instanceof TextChannel)) continue;

          const message = await channel.messages.fetch(panelRecord.messageId).catch(() => null);
          if (!message) {
            await prisma.panel.delete({ where: { id: panelRecord.id } }).catch(() => {});
            continue;
          }

          try {
            await editPanelMessage(message, panelContent);
          } catch (err) {
            if (isStaleDiscordResource(err)) {
              await prisma.panel.delete({ where: { id: panelRecord.id } }).catch(() => {});
            } else {
              console.error(`Failed to edit message ${panelRecord.messageId}:`, err);
            }
          }
        } catch (err) {
          if (isStaleDiscordResource(err)) {
            await prisma.panel.delete({ where: { id: panelRecord.id } }).catch(() => {});
          } else {
            console.error(`Error refreshing panel ${panelRecord.id}:`, err);
          }
        }

        await sleep(PANEL_EDIT_DELAY_MS);
      }
    }
  } catch (err) {
    console.error('Error refreshing panels:', err);
  }
}

/** Coalesce burst refresh calls (ticket closes, stock changes) into one panel rebuild. */
export function refreshAllPanels(delayMs = PANEL_REFRESH_DEBOUNCE_MS): void {
  if (panelRefreshTimer) clearTimeout(panelRefreshTimer);
  panelRefreshTimer = setTimeout(async () => {
    panelRefreshTimer = null;
    if (panelRefreshInFlight) {
      panelRefreshQueued = true;
      return;
    }
    panelRefreshInFlight = true;
    try {
      await refreshAllPanelsNow();
    } finally {
      panelRefreshInFlight = false;
      if (panelRefreshQueued) {
        panelRefreshQueued = false;
        refreshAllPanels(500);
      }
    }
  }, delayMs);
}

export async function refreshAllPanelsImmediate(): Promise<void> {
  if (panelRefreshTimer) {
    clearTimeout(panelRefreshTimer);
    panelRefreshTimer = null;
  }
  await refreshAllPanelsNow();
}

export async function postMainPanel(channel: TextBasedChannel) {
  if (channel.isTextBased() && 'send' in channel) {
    const guildId = (channel as TextChannel).guildId || '';
    const panel = await createMainPanel(guildId);
    const payload: Parameters<TextChannel['send']>[0] = { ...panel };

    if (!getPanelAssetUrl('gamegen.png')) {
      payload.files = [new AttachmentBuilder(panelImageAttachmentPath('gamegen.png'), { name: 'gamegen.png' })];
    }

    const sentMessage = await sendMessageWithRetry(channel as TextChannel, payload);

    await prisma.panel.create({
      data: { channelId: channel.id, messageId: sentMessage.id }
    }).catch(() => {});
  }
}

export async function resumeFromMaintenance(channelId: string, messageId?: string) {
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null) as TextBasedChannel | null;
    if (channel) {
      if (messageId && 'messages' in channel) {
        const msg = await (channel as TextChannel).messages.fetch(messageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      }

      await postMainPanel(channel);

      const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
      if (guild) {
        await logAction(guild, '🔄 System Resumed', `Maintenance ended in <#${channelId}>. Panel has been restored.`, 0x5865F2);
      }
    }
    await prisma.maintenance.deleteMany({ where: { channelId } });
  } catch (err) {
    console.error(`Failed to resume from maintenance in ${channelId}:`, err);
  }
}
