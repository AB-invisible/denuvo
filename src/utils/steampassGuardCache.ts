/**
 * steampassGuardCache.ts — reuse Steam Guard codes until steampass says they expire.
 *
 * /email/code/main is the endpoint steampass throttles hardest ("requested again
 * too soon"). The API returns valid_until on each code. Caching and reusing a
 * code within that window means zero repeat calls for back-to-back gens on the
 * same game/account — exactly what a human would do (use the code they just got).
 */

import prisma from '../lib/prisma';

interface GuardEntry {
  code: string;
  validUntil: string; // ISO
}

function cacheKey(login: string, uuid: string): string {
  return `steampass_guard:${login}:${uuid}`;
}

export async function getCachedGuardCode(login: string, uuid: string): Promise<GuardEntry | null> {
  if (!login || !uuid) return null;
  try {
    const row = await prisma.metadata.findUnique({ where: { key: cacheKey(login, uuid) } });
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as GuardEntry;
    if (!parsed?.code || !parsed?.validUntil) return null;
    const until = Date.parse(parsed.validUntil);
    if (!Number.isFinite(until) || until <= Date.now()) {
      await prisma.metadata.deleteMany({ where: { key: cacheKey(login, uuid) } }).catch(() => {});
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function setCachedGuardCode(
  login: string,
  uuid: string,
  code: string,
  validUntil: string,
): Promise<void> {
  if (!login || !uuid || !code || !validUntil) return;
  const until = Date.parse(validUntil);
  if (!Number.isFinite(until) || until <= Date.now()) return;
  try {
    await prisma.metadata.upsert({
      where: { key: cacheKey(login, uuid) },
      update: { value: JSON.stringify({ code, validUntil }) },
      create: { key: cacheKey(login, uuid), value: JSON.stringify({ code, validUntil }) },
    });
    console.log(`[SteampassGuard] Cached guard code for ${login} / ${uuid.slice(0, 8)}… until ${validUntil}`);
  } catch (e) {
    console.warn('[SteampassGuard] cache save failed (non-fatal):', (e as Error).message);
  }
}
