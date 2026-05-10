import { client } from '../client';
import { CONFIG } from '../config';
import { TextChannel, AttachmentBuilder } from 'discord.js';
import { createMainPanel } from './embeds';
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
        console.error(`Error refreshing panel ${panelRecord.id}:`, err);
        // On significant error (like channel gone), remove the record
        await prisma.panel.delete({ where: { id: panelRecord.id } }).catch(() => {});
      }
    }));
  } catch (err) {
    console.error('Error refreshing panels:', err);
  }
}
