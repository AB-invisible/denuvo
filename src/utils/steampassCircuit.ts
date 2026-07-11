/**
 * steampassCircuit.ts — a persistent circuit breaker for steampass.gg.
 *
 * Problem it solves: steampass rate-limits / IP-bans us when we make too many
 * calls (POST /auth/login, GET /profile/product-credentials, POST
 * /email/code/main). The per-gen retry loop already aborts on a 429/403, but
 * nothing stopped the NEXT ticket from immediately hammering steampass again —
 * so a throttle turned into a sustained block.
 *
 * This breaker trips on a throttle signal and stays tripped for a cooldown
 * window (STEAMPASS_COOLDOWN_MINUTES, default 20). While tripped, token
 * generation runs with STEAMPASS_DISABLED=true: Python only tries the free
 * cached refresh_token path (zero steampass calls) and the owned/steamauth
 * accounts, which don't touch steampass at all. Games with a warm
 * refresh_token keep working; cold games fail cleanly (routed to try-later /
 * manual) instead of digging the ban deeper. Any successful steampass call
 * resets the breaker.
 *
 * State lives in the Metadata table so it survives restarts and is shared
 * across the process. All operations are best-effort — a DB hiccup must never
 * block a gen, so failures fall back to "not blocked".
 */

import prisma from '../lib/prisma';
import { CONFIG } from '../config';

const KEY = 'steampass_blocked_until';

/** Milliseconds the breaker stays open after a throttle. */
export function cooldownMs(): number {
  return Math.max(1, CONFIG.STEAMPASS_COOLDOWN_MINUTES) * 60_000;
}

/** Remaining block time in ms (0 = not blocked). Best-effort. */
export async function steampassBlockRemainingMs(): Promise<number> {
  try {
    const row = await prisma.metadata.findUnique({ where: { key: KEY } });
    if (!row?.value) return 0;
    const until = Date.parse(row.value);
    if (!Number.isFinite(until)) return 0;
    return Math.max(0, until - Date.now());
  } catch {
    return 0;
  }
}

/** True while the steampass fallback should be skipped. */
export async function isSteampassBlocked(): Promise<boolean> {
  return (await steampassBlockRemainingMs()) > 0;
}

/**
 * Open the breaker for the cooldown window. Called when a gen's logs show a
 * steampass throttle/ban. Idempotent — re-tripping just refreshes the window.
 */
export async function tripSteampassBreaker(reason = ''): Promise<void> {
  const until = new Date(Date.now() + cooldownMs());
  try {
    await prisma.metadata.upsert({
      where: { key: KEY },
      update: { value: until.toISOString() },
      create: { key: KEY, value: until.toISOString() },
    });
    console.warn(
      `[SteampassCircuit] TRIPPED for ${CONFIG.STEAMPASS_COOLDOWN_MINUTES}m (until ${until.toISOString()}). ` +
      `Steampass calls are paused; only cached refresh_token gens will run.` +
      (reason ? ` Reason: ${reason.slice(0, 200)}` : ''),
    );
  } catch (e) {
    console.warn('[SteampassCircuit] Failed to persist trip (non-fatal):', (e as Error).message);
  }
}

/** Close the breaker. Called on a successful steampass call or manual reset. */
export async function resetSteampassBreaker(): Promise<void> {
  try {
    const existing = await prisma.metadata.findUnique({ where: { key: KEY } });
    if (!existing) return; // nothing to clear — avoid noisy log/DB churn
    await prisma.metadata.deleteMany({ where: { key: KEY } });
    console.log('[SteampassCircuit] Reset — steampass calls re-enabled.');
  } catch (e) {
    console.warn('[SteampassCircuit] Failed to reset (non-fatal):', (e as Error).message);
  }
}
