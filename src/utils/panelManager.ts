import { client } from '../client';
import { CONFIG } from '../config';
import { TextChannel, AttachmentBuilder, TextBasedChannel } from 'discord.js';
import { createMainPanel } from './embeds';
import { logAction } from './logging';
import prisma from '../lib/prisma';
import path from 'path';

/**
 * Refreshes all active game selection panels in the guild.
 */
export async function refreshAllPanels() {
  try {
    const panels = await prisma.panel.findMany();
    const panelContent = await createMainPanel();
    // Bug #17 fix: Consistent path resolution (__dirname is src/utils/, so ../../src/public/ = ../public/)
    const imagePath = path.join(__dirname, '../public/gamegen.png');
    
    // We recreate the attachment for each message to ensure it's sent properly
    // but in practice, Discord might allow reuse or we might need to send it once.
    // For editing, we reuse the existing attachment if possible, but here we re-attach.

    await Promise.allSettled(panels.map(async (panelRecord) => {
      try {

        const channel = await client.channels.fetch(panelRecord.channelId).catch(() => null);
        
        if (!channel || !(channel instanceof TextChannel)) {
          await prisma.panel.delete({ where: { id: panelRecord.id } }).catch(() => {});
          return;
        }
        
        const message = await channel.messages.fetch(panelRecord.messageId).catch(() => null);
        if (message) {
          // Optimization: Check if the message already has the gamegen.png attachment.
          // If it does, we don't need to re-upload it (saving 2.3MB per refresh).
          const hasImage = message.attachments.some(a => a.name === 'gamegen.png');
          
          await message.edit({
            embeds: panelContent.embeds,
            components: panelContent.components,
            // Only re-attach if the image is missing
            ...(hasImage ? {} : { files: [new AttachmentBuilder(imagePath, { name: 'gamegen.png' })] })
          }).catch((e) => console.error(`Failed to edit message ${panelRecord.messageId}:`, e));
        } else {
          // If message is gone, remove from database
          await prisma.panel.delete({ where: { id: panelRecord.id } }).catch(() => {});
        }

      } catch (err) {
        const e = err as any;
        const isGone = e?.code === 10003 || e?.code === 10008 || e?.status === 404;
        if (isGone) {
          await prisma.panel.delete({ where: { id: panelRecord.id } }).catch(() => {});
        } else {
          console.error(`Error refreshing panel ${panelRecord.id}:`, err);
        }
      }
    }));
  } catch (err) {
    console.error('Error refreshing panels:', err);
  }
}

export async function postMainPanel(channel: TextBasedChannel) {
  if (channel.isTextBased() && 'send' in channel) {
    const panel = await createMainPanel();
    const coverPath = path.join(__dirname, '../public/gamegen.png');
    const cover = new AttachmentBuilder(coverPath, { name: 'gamegen.png' });

    const sentMessage = await (channel as TextChannel).send({
      ...panel,
      files: [cover]
    });

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
