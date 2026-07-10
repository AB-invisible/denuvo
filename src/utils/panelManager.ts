import { client } from '../client';
import { CONFIG } from '../config';
import { TextChannel, AttachmentBuilder, TextBasedChannel, Message, MessageEditOptions } from 'discord.js';
import { createMainPanel } from './embeds';
import { logAction } from './logging';
import { getPanelAssetUrl, panelImageAttachmentPath } from './downloadHost';
import prisma from '../lib/prisma';

function isStaleDiscordResource(err: unknown): boolean {
  const e = err as { code?: number; status?: number };
  return e?.code === 10003 || e?.code === 10008 || e?.status === 404;
}

function logDiscordApiError(context: string, err: unknown): void {
  const raw = (err as { rawError?: unknown }).rawError;
  if (raw) console.error(`[Panel] ${context} Discord API error:`, JSON.stringify(raw));
}

async function editMessageWithRetry(message: Message, payload: MessageEditOptions, retries = 2): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await message.edit(payload);
      return;
    } catch (err) {
      if (isStaleDiscordResource(err)) throw err;
      const status = (err as { status?: number }).status;
      if (status === 500 && attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      logDiscordApiError('edit', err);
      throw err;
    }
  }
}

export async function sendMessageWithRetry(
  channel: TextChannel,
  payload: Parameters<TextChannel['send']>[0],
  retries = 2,
): Promise<Message> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await channel.send(payload);
    } catch (err) {
      if (isStaleDiscordResource(err)) throw err;
      const status = (err as { status?: number }).status;
      if (status === 500 && attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
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
export async function refreshAllPanels() {
  try {
    const panels = await prisma.panel.findMany();
    const usesAttachmentImage = !getPanelAssetUrl('gamegen.png');
    const imagePath = panelImageAttachmentPath('gamegen.png');

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

    // Generate per-guild panel content and update
    for (const [guildId, guildPanelList] of guildPanels) {
      const panelContent = await createMainPanel(guildId);
      await Promise.allSettled(guildPanelList.map(async (panelRecord) => {
        try {
          const channel = await client.channels.fetch(panelRecord.channelId).catch(() => null);
          if (!channel || !(channel instanceof TextChannel)) return;

          const message = await channel.messages.fetch(panelRecord.messageId).catch(() => null);
          if (!message) {
            await prisma.panel.delete({ where: { id: panelRecord.id } }).catch(() => {});
            return;
          }

          const hasImage = message.attachments.some(a => a.name === 'gamegen.png');
          try {
            await editMessageWithRetry(message, {
              embeds: panelContent.embeds,
              components: panelContent.components,
              ...(usesAttachmentImage && !hasImage
                ? { files: [new AttachmentBuilder(imagePath, { name: 'gamegen.png' })] }
                : {}),
            });
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
      }));
    }
  } catch (err) {
    console.error('Error refreshing panels:', err);
  }
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
