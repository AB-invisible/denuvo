import { client } from '../client';
import { CONFIG } from '../config';
import {
  TextChannel,
  TextBasedChannel,
  Message,
  MessageEditOptions,
  MessageFlags,
} from 'discord.js';
import { createMainPanel } from './embeds';
import { logAction } from './logging';
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

function isRateLimited(err: unknown): boolean {
  const e = err as { status?: number; code?: number };
  return e?.status === 429 || e?.code === 429;
}

function isRetryableDiscordError(err: unknown): boolean {
  return isDiscord500(err) || isRateLimited(err);
}

function logDiscordApiError(context: string, err: unknown): void {
  const raw = (err as { rawError?: unknown }).rawError;
  if (raw) console.error(`[Panel] ${context} Discord API error:`, JSON.stringify(raw));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The panel is a Components V2 message: no embeds, no file attachments — just
// the container. Sends carry the IsComponentsV2 flag; edits only swap the
// components (a message's V2-ness is fixed at creation and can't be edited on).

async function editMessageWithRetry(message: Message, payload: MessageEditOptions, retries = 4): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await message.edit(payload);
      return;
    } catch (err) {
      if (isStaleDiscordResource(err)) throw err;
      if (isRetryableDiscordError(err) && attempt < retries) {
        const delay = isRateLimited(err) ? 2000 * (attempt + 1) : 1000 * (attempt + 1);
        await sleep(delay);
        continue;
      }
      logDiscordApiError('edit', err);
      throw err;
    }
  }
}

async function repostPanelMessage(
  channel: TextChannel,
  panelRecord: { id: number; messageId: string },
  panelContent: Awaited<ReturnType<typeof createMainPanel>>,
  oldMessage: Message,
): Promise<void> {
  const sentMessage = await sendMessageWithRetry(channel, panelContent);
  await prisma.panel.update({
    where: { id: panelRecord.id },
    data: { messageId: sentMessage.id },
  }).catch(() => {});
  await oldMessage.delete().catch(() => {});
  console.log(`[Panel] Reposted panel #${panelRecord.id} in #${channel.id} (new message ${sentMessage.id})`);
}

async function editPanelMessage(
  message: Message,
  channel: TextChannel,
  panelRecord: { id: number; messageId: string },
  panelContent: Awaited<ReturnType<typeof createMainPanel>>,
): Promise<void> {
  // A message's V2-ness is fixed at creation. Old (embed) panels from before
  // this redesign can't be edited into a V2 container, so repost them once.
  if (!message.flags.has(MessageFlags.IsComponentsV2)) {
    await repostPanelMessage(channel, panelRecord, panelContent, message);
    return;
  }

  try {
    // Edit swaps only the components — the V2 flag is already set on the message.
    await editMessageWithRetry(message, { components: panelContent.components });
    return;
  } catch (err) {
    if (isStaleDiscordResource(err)) throw err;
    if (!isRetryableDiscordError(err)) throw err;
    console.warn(`[Panel] Edit failed for ${message.id} — reposting panel message`);
  }

  await repostPanelMessage(channel, panelRecord, panelContent, message);
}

export async function sendMessageWithRetry(
  channel: TextChannel,
  payload: Parameters<TextChannel['send']>[0],
  retries = 4,
): Promise<Message> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await channel.send(payload);
    } catch (err) {
      if (isStaleDiscordResource(err)) throw err;
      if (isRetryableDiscordError(err) && attempt < retries) {
        const delay = isRateLimited(err) ? 2000 * (attempt + 1) : 1000 * (attempt + 1);
        await sleep(delay);
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
    if (panels.length === 0) return;

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

    let refreshed = 0;
    let failed = 0;

    // Generate per-guild panel content and update sequentially — parallel
    // PATCHes across channels often trigger transient Discord 500s.
    for (const [guildId, guildPanelList] of guildPanels) {
      let panelContent: Awaited<ReturnType<typeof createMainPanel>>;
      try {
        panelContent = await createMainPanel(guildId);
      } catch (err) {
        console.error(`[Panel] Failed to build panel content for guild ${guildId}:`, err);
        failed += guildPanelList.length;
        continue;
      }

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
            await editPanelMessage(message, channel, panelRecord, panelContent);
            refreshed++;
          } catch (err) {
            if (isStaleDiscordResource(err)) {
              await prisma.panel.delete({ where: { id: panelRecord.id } }).catch(() => {});
            } else {
              failed++;
              console.error(`Failed to edit message ${panelRecord.messageId}:`, err);
            }
          }
        } catch (err) {
          if (isStaleDiscordResource(err)) {
            await prisma.panel.delete({ where: { id: panelRecord.id } }).catch(() => {});
          } else {
            failed++;
            console.error(`Error refreshing panel ${panelRecord.id}:`, err);
          }
        }

        await sleep(PANEL_EDIT_DELAY_MS);
      }
    }

    if (refreshed > 0 || failed > 0) {
      console.log(`[Panel] Refresh complete — ${refreshed} updated, ${failed} failed`);
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
    const sentMessage = await sendMessageWithRetry(channel as TextChannel, panel);

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
