import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';

const META_KEY = 'steampassDisabled';

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

function parseDisabled(value: string | null | undefined): boolean | null {
  const v = (value || '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

/** Load persisted steampass toggle (Metadata) into CONFIG on startup. */
export async function hydrateSteampassSetting(): Promise<boolean> {
  try {
    const row = await prisma.metadata.findUnique({ where: { key: META_KEY } });
    const stored = parseDisabled(row?.value);
    if (stored !== null) {
      CONFIG.STEAMPASS_DISABLED = stored;
      return stored;
    }

    const current = CONFIG.STEAMPASS_DISABLED;
    await prisma.metadata.upsert({
      where: { key: META_KEY },
      update: { value: current ? 'true' : 'false' },
      create: { key: META_KEY, value: current ? 'true' : 'false' },
    });
    return current;
  } catch (e) {
    console.warn('[SteampassSettings] hydrate failed (using env):', (e as Error).message);
    return CONFIG.STEAMPASS_DISABLED;
  }
}

export function isSteampassEnabled(): boolean {
  return !CONFIG.STEAMPASS_DISABLED;
}

export async function setSteampassEnabled(enabled: boolean): Promise<{ enabled: boolean; previous: boolean }> {
  const previous = !CONFIG.STEAMPASS_DISABLED;
  CONFIG.STEAMPASS_DISABLED = !enabled;

  await prisma.metadata.upsert({
    where: { key: META_KEY },
    update: { value: enabled ? 'false' : 'true' },
    create: { key: META_KEY, value: enabled ? 'false' : 'true' },
  });

  try {
    updateEnvKeys({ STEAMPASS_DISABLED: enabled ? 'false' : 'true' });
  } catch (e) {
    console.warn('[SteampassSettings] .env update failed (runtime change still applied):', (e as Error).message);
  }

  if (enabled) {
    const { resetSteampassBreaker } = await import('./steampassCircuit');
    await resetSteampassBreaker().catch(() => {});
  }

  return { enabled, previous };
}

export function describeSteampassMode(): string {
  if (CONFIG.STEAMPASS_DISABLED) {
    return '🔴 **Disabled** — autogen uses cached refresh tokens, SteamAuth, and BYO accounts only (no steampass.gg API calls).';
  }
  return '🟢 **Enabled** — token generation may call steampass.gg (login, profile, guard codes).';
}
