import { Client, TextChannel } from 'discord.js';
import { CONFIG } from '../config';
import { resolvePlatformPublicUrl } from './cloudPublicUrl';

const INTERVAL_MS = 10 * 60 * 1000;

let keepAliveMessageId: string | null = null;

async function pingPublicHealth(): Promise<void> {
  const base = resolvePlatformPublicUrl();
  if (!base) return;
  const res = await fetch(`${base}/payload/health`, {
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res?.ok) {
    console.warn('[KeepAlive] Public health ping failed');
  }
}

async function pingDiscordChannel(client: Client): Promise<void> {
  const channelId = CONFIG.KEEPALIVE_CHANNEL_ID;
  if (!channelId) return;

  const channel = (await client.channels.fetch(channelId).catch(() => null)) as TextChannel | null;
  if (!channel?.isTextBased()) {
    console.warn(`[KeepAlive] Channel ${channelId} not found or not text`);
    return;
  }

  const text = `🟢 keepalive · ${new Date().toISOString()}`;

  if (keepAliveMessageId) {
    const existing = await channel.messages.fetch(keepAliveMessageId).catch(() => null);
    if (existing) {
      await existing.edit(text);
      return;
    }
    keepAliveMessageId = null;
  }

  const msg = await channel.send(text);
  keepAliveMessageId = msg.id;
}

async function tick(client: Client): Promise<void> {
  await pingPublicHealth();
  await pingDiscordChannel(client);
}

/** Prevent Render free-tier sleep: inbound HTTP + optional Discord heartbeat. */
export function startRenderKeepAlive(client: Client): void {
  const onRender = !!(process.env.RENDER_EXTERNAL_URL || '').trim();
  const forced = process.env.KEEPALIVE_ENABLED === 'true';
  if (!onRender && !forced) return;

  console.log(
    `[KeepAlive] Every ${INTERVAL_MS / 60_000}m — health ping` +
      (CONFIG.KEEPALIVE_CHANNEL_ID ? ` + channel ${CONFIG.KEEPALIVE_CHANNEL_ID}` : ''),
  );

  void tick(client).catch((e) => console.warn('[KeepAlive] First tick failed:', e));
  setInterval(() => {
    void tick(client).catch((e) => console.warn('[KeepAlive] Tick failed:', e));
  }, INTERVAL_MS);
}
