import { TextChannel, EmbedBuilder, User, Guild } from 'discord.js';
import { CONFIG } from '../config';
import { client } from '../client';

export async function logGlobal(title: string, description: string, color: number, fields: { name: string, value: string, inline?: boolean }[] = []) {
  const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
  if (!guild) return;
  return logAction(guild, title, description, color, fields);
}

export async function logAction(guild: Guild, title: string, description: string, color: number, fields: { name: string, value: string, inline?: boolean }[] = []) {
  // Detailed logs ALWAYS go to the home server (CRITICAL SECRECY RULE)
  const homeGuild = client.guilds.cache.get(CONFIG.OWNER_GUILD_ID || CONFIG.GUILD_ID);
  if (!homeGuild) return;

  // Try to find a log channel. Priority: LOG_CHANNEL_ID from config -> 'gen-logs' name
  let logChannel = homeGuild.channels.cache.get(CONFIG.LOG_CHANNEL_ID) as TextChannel;

  if (!logChannel) {
    logChannel = homeGuild.channels.cache.find(
      c => (c.name === 'gen-logs' || c.name === 'logs') && c.isTextBased()
    ) as TextChannel;
  }

  if (!logChannel) return;

  // Truncate to stay within Discord's embed limits:
  //   title <=256 chars, description <=4096, field name <=256, field value <=1024
  const safeTitle = (title || '').slice(0, 256);
  const safeDescription = (description || '').slice(0, 4000); // 4000 not 4096, leaves headroom
  const safeFields = fields.slice(0, 25).map(f => ({
    name: (f.name || '').slice(0, 256),
    value: (f.value || '').slice(0, 1024),
    inline: f.inline ?? false,
  }));

  const embed = new EmbedBuilder()
    .setTitle(safeTitle)
    .setDescription(safeDescription)
    .setColor(color)
    .addFields(safeFields)
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

/**
 * Basic, SANITIZED log for a buyer (tenant) server's own log channel.
 *
 * Buyer servers see lifecycle events only — ticket opened/closed, token
 * delivered (game + user), stock changes. They must NEVER see steampass
 * account info, Steam errors, ticket bytes, or HMAC/installer-key detail;
 * that goes to the owner home channel via logAction() only.
 *
 * No-op for the owner/home server (it has no separate tenant channel) and
 * for any tenant that hasn't set a log channel yet. Resolution of the
 * channel goes through the tenant resolver so per-server config applies.
 */
export async function logTenant(
  guildId: string,
  title: string,
  description: string,
  color: number = 0x5865F2,
) {
  try {
    // Lazy import avoids a circular dependency (tenant.ts → config, and
    // logging is imported very widely). Safe because this runs at call
    // time, not module load.
    const { resolveServerConfig } = await import('./tenant');
    const sc = await resolveServerConfig(guildId);
    if (!sc.tenantLogChannelId) return; // home server or unconfigured tenant

    const channel = (await client.channels.fetch(sc.tenantLogChannelId).catch(() => null)) as TextChannel | null;
    if (!channel || !channel.isTextBased?.()) return;

    const embed = new EmbedBuilder()
      .setTitle((title || '').slice(0, 256))
      .setDescription((description || '').slice(0, 4000))
      .setColor(color)
      .setTimestamp()
      .setFooter({ text: `${sc.botName}` });

    await channel.send({ embeds: [embed] }).catch(() => {});
  } catch (err) {
    console.error('[logTenant] Failed to send tenant log:', err);
  }
}
