import { TextChannel, AttachmentBuilder, Message } from 'discord.js';
import prisma from '../lib/prisma';
import { createMaintenancePanel } from '../utils/embeds';
import { resumeFromMaintenance, sendMessageWithRetry } from '../utils/panelManager';
import { getPanelAssetUrl, panelImageAttachmentPath } from '../utils/downloadHost';

export async function execute(interaction: any): Promise<void> {
  const duration = interaction.options.getInteger('duration');
  const channel = interaction.channel;

  if (channel?.isTextBased()) {
    const panels = await prisma.panel.findMany({ where: { channelId: interaction.channelId } });
    for (const p of panels) {
      try {
        if ('messages' in channel) {
          const msg = await (channel as TextChannel).messages.fetch(p.messageId);
          if (msg) await msg.delete().catch(() => {});
        }
      } catch (e) {}
    }
    await prisma.panel.deleteMany({ where: { channelId: interaction.channelId } }).catch(() => {});

    const maintenancePanel = await createMaintenancePanel(duration);
    const payload: Parameters<TextChannel['send']>[0] = { ...maintenancePanel };
    if (!getPanelAssetUrl('maintenance.png')) {
      payload.files = [new AttachmentBuilder(panelImageAttachmentPath('maintenance.png'), { name: 'maintenance.png' })];
    }

    let maintenanceMessage: Message | null = null;
    if (channel && 'send' in channel) {
      maintenanceMessage = await sendMessageWithRetry(channel as TextChannel, payload);
    }

    if (duration && duration > 0) {
      const endTime = new Date(Date.now() + duration * 60000);

      if (maintenanceMessage) {
        await prisma.maintenance.upsert({
          where: { channelId: interaction.channelId },
          update: { messageId: maintenanceMessage.id, endTime: endTime },
          create: { channelId: interaction.channelId, messageId: maintenanceMessage.id, endTime: endTime }
        }).catch((e: Error) => console.error('Failed to persist maintenance state:', e));
      }

      await interaction.editReply({ content: `✅ **Maintenance Active:** Dashboard switch triggered. System will auto-resume in **${duration} minutes**.` });
      setTimeout(() => resumeFromMaintenance(interaction.channelId, maintenanceMessage?.id), duration * 60000);
    } else {
      await interaction.editReply({ content: '✅ **Dashboard Switch:** Maintenance mode activated.' });
    }
  }
}
