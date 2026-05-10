import { TextChannel, EmbedBuilder, User, Guild } from 'discord.js';
import { CONFIG } from '../config';
import { client } from '../client';

export async function logGlobal(title: string, description: string, color: number, fields: { name: string, value: string, inline?: boolean }[] = []) {
  const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
  if (!guild) return;
  return logAction(guild, title, description, color, fields);
}

export async function logAction(guild: Guild, title: string, description: string, color: number, fields: { name: string, value: string, inline?: boolean }[] = []) {
  // Try to find a log channel. Priority: LOG_CHANNEL_ID from config -> 'gen-logs' name
  let logChannel = guild.channels.cache.get(CONFIG.LOG_CHANNEL_ID) as TextChannel;
  
  if (!logChannel) {
    logChannel = guild.channels.cache.find(
      c => (c.name === 'gen-logs' || c.name === 'logs') && c.isTextBased()
    ) as TextChannel;
  }
  
  if (!logChannel) return;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .addFields(fields)
    .setTimestamp();

  try {
    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Failed to send log message:', err);
  }
}

export async function logStockNotification(gameName: string, status: 'DEPLETED' | 'RESTOCKED', amount?: number) {
  const channel = (await client.channels.fetch(CONFIG.STOCK_NOTIF_CHANNEL_ID).catch(() => null)) as TextChannel;
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle(status === 'DEPLETED' ? '🚨 Game Out of Stock' : '✅ Game Token Restocked')
    .setDescription(status === 'DEPLETED' 
      ? `**${gameName}** is now out of stock. Individual token regeneration is active.` 
      : status === 'RESTOCKED' && amount 
        ? `**${amount} token(s)** have been restocked for **${gameName}**!`
        : `**${gameName}** has received a new token and is active!`)
    .setColor(status === 'DEPLETED' ? 0xED4245 : 0x57F287)
    .setTimestamp();

  await channel.send({ embeds: [embed] }).catch(() => {});
}
