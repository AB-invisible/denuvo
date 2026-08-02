import fs from 'fs';
import path from 'path';
import type { Client } from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { invalidateTenantCache } from './tenant';

const META_KEY = 'ownerGuildId';

let reregisterGuildCommands: ((guildIds: string[]) => Promise<void>) | null = null;

export function setGuildCommandReregister(fn: (guildIds: string[]) => Promise<void>) {
  reregisterGuildCommands = fn;
}

function envPath(): string {
  return path.resolve(process.cwd(), '.env');
}

function updateEnvKeys(updates: Record<string, string>): void {
  const file = envPath();
  if (!fs.existsSync(file)) return;

  let text = fs.readFileSync(file, 'utf8');
  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) {
      text = text.replace(re, `${key}=${value}`);
    } else {
      text = text.endsWith('\n') ? `${text}${key}=${value}\n` : `${text}\n${key}=${value}\n`;
    }
  }
  fs.writeFileSync(file, text, 'utf8');
}

export interface OwnerGuildMigrationStats {
  serverStock: number;
  restock: number;
  cooldown: number;
  blacklist: number;
  tickets: number;
  steamSessions: number;
  eaAccounts: number;
  ubisoftAccounts: number;
  promoRedemptions: number;
  patreonReservations: number;
  tokenDownloads: number;
}

/** Move owner-scoped rows from the old home guild id to the new one. */
export async function migrateOwnerGuildData(
  previousGuildId: string,
  newGuildId: string,
): Promise<OwnerGuildMigrationStats> {
  const stats: OwnerGuildMigrationStats = {
    serverStock: 0,
    restock: 0,
    cooldown: 0,
    blacklist: 0,
    tickets: 0,
    steamSessions: 0,
    eaAccounts: 0,
    ubisoftAccounts: 0,
    promoRedemptions: 0,
    patreonReservations: 0,
    tokenDownloads: 0,
  };

  if (!previousGuildId || previousGuildId === newGuildId) return stats;

  const stocks = await prisma.serverStock.findMany({ where: { guildId: previousGuildId } });
  for (const row of stocks) {
    const conflict = await prisma.serverStock.findUnique({
      where: { gameId_guildId: { gameId: row.gameId, guildId: newGuildId } },
    });
    if (conflict) {
      await prisma.serverStock.delete({ where: { id: row.id } });
    } else {
      await prisma.serverStock.update({ where: { id: row.id }, data: { guildId: newGuildId } });
    }
    stats.serverStock += 1;
  }

  const simpleUpdates: { key: keyof OwnerGuildMigrationStats; run: () => Promise<{ count: number }> }[] = [
    {
      key: 'restock',
      run: () => prisma.restock.updateMany({ where: { guildId: previousGuildId }, data: { guildId: newGuildId } }),
    },
    {
      key: 'cooldown',
      run: () => prisma.cooldown.updateMany({ where: { guildId: previousGuildId }, data: { guildId: newGuildId } }),
    },
    {
      key: 'blacklist',
      run: () => prisma.denuvoBlacklist.updateMany({ where: { guildId: previousGuildId }, data: { guildId: newGuildId } }),
    },
    {
      key: 'tickets',
      run: () => prisma.ticket.updateMany({ where: { guildId: previousGuildId }, data: { guildId: newGuildId } }),
    },
    {
      key: 'steamSessions',
      run: () => (prisma as any).steamSession.updateMany({
        where: { guildId: previousGuildId },
        data: { guildId: newGuildId },
      }),
    },
    {
      key: 'eaAccounts',
      run: () => (prisma as any).eaAccount.updateMany({
        where: { guildId: previousGuildId },
        data: { guildId: newGuildId },
      }),
    },
    {
      key: 'ubisoftAccounts',
      run: () => (prisma as any).ubisoftAccount.updateMany({
        where: { guildId: previousGuildId },
        data: { guildId: newGuildId },
      }),
    },
    {
      key: 'promoRedemptions',
      run: () => (prisma as any).promoRedemption.updateMany({
        where: { guildId: previousGuildId },
        data: { guildId: newGuildId },
      }),
    },
    {
      key: 'patreonReservations',
      run: () => (prisma as any).patreonReservation.updateMany({
        where: { guildId: previousGuildId },
        data: { guildId: newGuildId },
      }),
    },
    {
      key: 'tokenDownloads',
      run: () => (prisma as any).tokenDownload.updateMany({
        where: { guildId: previousGuildId },
        data: { guildId: newGuildId },
      }),
    },
  ];

  for (const { key, run } of simpleUpdates) {
    try {
      const result = await run();
      stats[key] = result.count;
    } catch (e) {
      console.warn(`[OwnerGuild] migrate ${key} failed:`, (e as Error).message);
    }
  }

  return stats;
}

/** Load persisted owner guild id (Metadata) into CONFIG before command registration. */
export async function hydrateOwnerGuildId(): Promise<string> {
  try {
    const row = await prisma.metadata.findUnique({ where: { key: META_KEY } });
    const stored = row?.value?.trim();
    if (stored) {
      CONFIG.OWNER_GUILD_ID = stored;
      CONFIG.GUILD_ID = stored;
      return stored;
    }

    const current = (CONFIG.OWNER_GUILD_ID || CONFIG.GUILD_ID || '').trim();
    if (current) {
      await prisma.metadata.upsert({
        where: { key: META_KEY },
        update: { value: current },
        create: { key: META_KEY, value: current },
      });
    }
    return CONFIG.OWNER_GUILD_ID;
  } catch (e) {
    console.warn('[OwnerGuild] hydrate failed (using env):', (e as Error).message);
    return CONFIG.OWNER_GUILD_ID;
  }
}

export async function switchOwnerGuild(
  newGuildId: string,
  client: Client,
): Promise<{
  previous: string;
  current: string;
  guildName: string;
  removedTenant: boolean;
  migration: OwnerGuildMigrationStats;
}> {
  const trimmed = newGuildId.trim();
  if (!/^\d{17,20}$/.test(trimmed)) {
    throw new Error('Guild ID must be a 17–20 digit Discord snowflake.');
  }

  const previous = CONFIG.OWNER_GUILD_ID;
  if (trimmed === previous) {
    throw new Error(`\`${trimmed}\` is already the owner server.`);
  }

  let guild = client.guilds.cache.get(trimmed) ?? null;
  if (!guild) {
    try {
      guild = await client.guilds.fetch(trimmed);
    } catch {
      throw new Error(`The bot is not in server \`${trimmed}\`. Invite it there first, then run this command again.`);
    }
  }

  let removedTenant = false;
  const tenant = await (prisma as any).tenantServer.findUnique({ where: { guildId: trimmed } }).catch(() => null);
  if (tenant) {
    await (prisma as any).tenantServer.delete({ where: { guildId: trimmed } });
    removedTenant = true;
    invalidateTenantCache();
  }

  const migration = await migrateOwnerGuildData(previous, trimmed);
  console.log('[OwnerGuild] Migrated owner data:', migration);

  await prisma.metadata.upsert({
    where: { key: META_KEY },
    update: { value: trimmed },
    create: { key: META_KEY, value: trimmed },
  });

  CONFIG.OWNER_GUILD_ID = trimmed;
  CONFIG.GUILD_ID = trimmed;

  try {
    updateEnvKeys({ OWNER_GUILD_ID: trimmed, GUILD_ID: trimmed });
  } catch (e) {
    console.warn('[OwnerGuild] .env update failed (runtime switch still applied):', (e as Error).message);
  }

  if (reregisterGuildCommands) {
    await reregisterGuildCommands([previous, trimmed]);
  }

  invalidateTenantCache();

  try {
    const { syncAllOwnerGameStock } = await import('./accountCapacity');
    await syncAllOwnerGameStock(trimmed, { forceRaise: true });
  } catch (e) {
    console.warn('[OwnerGuild] stock sync on new home server failed:', (e as Error).message);
  }

  return { previous, current: trimmed, guildName: guild.name, removedTenant, migration };
}
