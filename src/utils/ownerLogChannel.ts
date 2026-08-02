import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';

const META_KEY = 'ownerLogChannelId';

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

/** Load persisted owner log channel (Metadata) into CONFIG on startup. */
export async function hydrateOwnerLogChannel(): Promise<string> {
  try {
    const row = await prisma.metadata.findUnique({ where: { key: META_KEY } });
    const stored = row?.value?.trim();
    if (stored) {
      CONFIG.LOG_CHANNEL_ID = stored;
      return stored;
    }

    const current = (CONFIG.LOG_CHANNEL_ID || '').trim();
    if (current) {
      await prisma.metadata.upsert({
        where: { key: META_KEY },
        update: { value: current },
        create: { key: META_KEY, value: current },
      });
    }
    return CONFIG.LOG_CHANNEL_ID;
  } catch (e) {
    console.warn('[OwnerLog] hydrate failed (using env):', (e as Error).message);
    return CONFIG.LOG_CHANNEL_ID;
  }
}

import { isSuperOwner } from './ownerAccess';

export async function setOwnerLogChannel(
  channelId: string,
  guildId: string,
  userId?: string,
): Promise<{ channelId: string; previous: string | null }> {
  if (!/^\d{17,20}$/.test(channelId)) {
    throw new Error('Invalid channel ID.');
  }
  if (guildId !== CONFIG.OWNER_GUILD_ID && !isSuperOwner(userId)) {
    throw new Error('This command can only be used on the owner server.');
  }

  const previous = CONFIG.LOG_CHANNEL_ID || null;

  await prisma.metadata.upsert({
    where: { key: META_KEY },
    update: { value: channelId },
    create: { key: META_KEY, value: channelId },
  });

  CONFIG.LOG_CHANNEL_ID = channelId;

  try {
    updateEnvKeys({ LOG_CHANNEL_ID: channelId });
  } catch (e) {
    console.warn('[OwnerLog] .env update failed (runtime change still applied):', (e as Error).message);
  }

  return { channelId, previous };
}
