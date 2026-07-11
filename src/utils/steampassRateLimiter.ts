/**
 * steampassRateLimiter.ts — make the bot hit steampass at *human* pace.
 *
 * A person using steampass never gets blocked because they log in once and
 * make a request every few seconds/minutes. The bot got blocked because it
 * could fire many calls back-to-back: several tickets verifying at once, plus
 * the per-gen account rotation, all spawning steampass work in parallel from
 * one IP. Steampass's anti-abuse triggers on that *velocity*, not the total
 * count.
 *
 * This is a global async mutex + minimum spacing. Only ONE steampass-touching
 * gen runs at a time, and consecutive ones are separated by at least
 * STEAMPASS_MIN_GAP_MS (plus a little jitter so it's not metronomic). Gens that
 * use a cached refresh_token make zero steampass calls and skip this entirely,
 * so the common warm path stays fast — only the calls that actually reach
 * steampass are paced.
 */

import { CONFIG } from '../config';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Serialization chain: each acquirer waits for the previous holder to release.
let tail: Promise<void> = Promise.resolve();
// Wall-clock time (ms) the last steampass-touching gen finished.
let lastReleaseAt = 0;

/** Configured floor gap between two steampass-touching gens, in ms. */
function minGapMs(): number {
  return Math.max(0, CONFIG.STEAMPASS_MIN_GAP_MS);
}

/**
 * Acquire the global steampass slot. Resolves once it's this caller's turn AND
 * enough time has elapsed since the previous gen. Returns a release function —
 * the caller MUST call it (in a finally / all resolve paths) or the queue
 * stalls. Holding the slot across the whole subprocess is intentional: it
 * guarantees strict one-at-a-time steampass access.
 */
export async function acquireSteampassSlot(label: string): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });

  const prior = tail;
  // The next acquirer can't proceed until we release.
  tail = prior.then(() => held);

  await prior; // wait our turn in line

  // Space this gen from the previous one to mimic human cadence.
  const gap = minGapMs();
  if (gap > 0) {
    const jitter = Math.floor(Math.random() * Math.min(1500, gap));
    const waitMs = Math.max(0, lastReleaseAt + gap - Date.now()) + jitter;
    if (waitMs > 0) {
      console.log(`[SteampassPace] ${label}: spacing steampass call by ${waitMs}ms (human-pace)`);
      await sleep(waitMs);
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    lastReleaseAt = Date.now();
    release();
  };
}
