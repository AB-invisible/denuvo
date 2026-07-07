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
    const imagePath = path.join(__dirname, '../public/gamegen.png');

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
        const e = err as any;
        if (e?.code === 10003 || e?.code === 10008 || e?.status === 404) {
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
          if (message) {
            const hasImage = message.attachments.some(a => a.name === 'gamegen.png');
            await message.edit({
              embeds: panelContent.embeds,
              components: panelContent.components,
              ...(hasImage ? {} : { files: [new AttachmentBuilder(imagePath, { name: 'gamegen.png' })] })
            }).catch((e) => console.error(`Failed to edit message ${panelRecord.messageId}:`, e));
          } else {
            await prisma.panel.delete({ where: { id: panelRecord.id } }).catch(() => {});
          }
        } catch (err) {
          const e = err as any;
          if (e?.code === 10003 || e?.code === 10008 || e?.status === 404) {
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
