import { Client, DMChannel, GuildMember } from 'discord.js';
import { CONFIG } from '../config';
import { resolvePlatformPublicUrl } from './cloudPublicUrl';

const INTERVAL_MS = 10 * 60 * 1000;

let keepAliveUserId: string | null = null;
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

async function resolveKeepAliveUser(client: Client): Promise<string | null> {
  if (keepAliveUserId) return keepAliveUserId;

  const configured = (CONFIG.KEEPALIVE_USER_ID || '').trim();
  if (configured) {
    keepAliveUserId = configured;
    return keepAliveUserId;
  }

  const username = (CONFIG.KEEPALIVE_USERNAME || '').trim().toLowerCase();
  if (!username) return null;

  const guild =
    client.guilds.cache.get(CONFIG.GUILD_ID) ||
    (await client.guilds.fetch(CONFIG.GUILD_ID).catch(() => null));
  if (!guild) {
    console.warn('[KeepAlive] Guild not found for user lookup');
    return null;
  }

  const query = username.replace(/^@/, '');
  const members = await guild.members.fetch({ query, limit: 20 }).catch(() => null);
  if (!members) return null;

  const match = members.find((m: GuildMember) => {
    const u = m.user.username.toLowerCase();
    const g = (m.user.globalName || '').toLowerCase();
    return u === query || g === query || u.includes(query) || query.includes(u);
  });

  if (!match) {
    console.warn(`[KeepAlive] User @${query} not found in guild`);
    return null;
  }

  keepAliveUserId = match.id;
  console.log(`[KeepAlive] Resolved @${match.user.username} → ${keepAliveUserId}`);
  return keepAliveUserId;
}

async function pingDiscordUser(client: Client): Promise<void> {
  const userId = await resolveKeepAliveUser(client);
  if (!userId) return;

  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) {
    console.warn(`[KeepAlive] Could not fetch user ${userId}`);
    return;
  }

  const dm = (await user.createDM().catch(() => null)) as DMChannel | null;
  if (!dm) {
    console.warn(`[KeepAlive] Could not open DM with ${userId}`);
    return;
  }

  if (keepAliveMessageId) {
    await dm.messages.delete(keepAliveMessageId).catch(() => {
      keepAliveMessageId = null;
    });
  }

  const msg = await dm.send(`<@${userId}>`);
  keepAliveMessageId = msg.id;
}

async function tick(client: Client): Promise<void> {
  await pingPublicHealth();
  await pingDiscordUser(client);
}

/** Prevent Render free-tier sleep: inbound HTTP + DM ping only. */
export function startRenderKeepAlive(client: Client): void {
  const onRender = !!(process.env.RENDER_EXTERNAL_URL || '').trim();
  const forced = process.env.KEEPALIVE_ENABLED === 'true';
  if (!onRender && !forced) return;

  const target = CONFIG.KEEPALIVE_USER_ID || `@${CONFIG.KEEPALIVE_USERNAME}`;
  console.log(`[KeepAlive] Every ${INTERVAL_MS / 60_000}m — health ping + DM ping ${target}`);

  void tick(client).catch((e) => console.warn('[KeepAlive] First tick failed:', e));
  setInterval(() => {
    void tick(client).catch((e) => console.warn('[KeepAlive] Tick failed:', e));
  }, INTERVAL_MS);
}
