/**
 * tokenQueue.ts — process token generations ONE AT A TIME, with a visible
 * "you're in line" position for each waiting user.
 *
 * When several tickets get verified at once, running their generations in
 * parallel is exactly what bursts steampass and gets us blocked. This is a
 * single global FIFO: each ticket's generation runs only after the previous
 * one finishes, and a user who lands behind others is told their position up
 * front so the wait is transparent (they don't have to do anything — it starts
 * automatically when it's their turn).
 *
 * When the queue is empty the task runs immediately, so a quiet server sees no
 * added delay — the line only forms under contention.
 */

import { EmbedBuilder, TextChannel } from 'discord.js';

interface QueueEntry {
  channel: TextChannel;
  label: string;
  task: () => Promise<void>;
}

const waiting: QueueEntry[] = [];
let active = false;

/** How many generations are queued or currently running. */
export function tokenQueueDepth(): number {
  return waiting.length + (active ? 1 : 0);
}

/**
 * Enqueue a token generation. Returns immediately after posting the position
 * message (if any); the task itself runs later when it reaches the front.
 */
export async function enqueueTokenGen(
  channel: TextChannel,
  label: string,
  task: () => Promise<void>,
): Promise<void> {
  const ahead = tokenQueueDepth();
  if (ahead > 0) {
    try {
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('⏳ You’re in the queue')
            .setDescription(
              `I generate tokens **one at a time** so we stay fast *and* don’t trip Steam’s rate limits.\n\n` +
                `**Your position:** #${ahead + 1} in line\n` +
                `Your **${label}** token will start **automatically** when it’s your turn — you don’t need to do anything.`,
            )
            .setColor(0x5865f2)
            .setTimestamp(),
        ],
      });
    } catch {
      /* position message is best-effort */
    }
  }

  waiting.push({ channel, label, task });
  void drain();
}

async function drain(): Promise<void> {
  if (active) return;
  active = true;
  try {
    while (waiting.length) {
      const entry = waiting.shift()!;
      try {
        await entry.task();
      } catch (e) {
        console.error(`[TokenQueue] generation for ${entry.label} failed:`, e);
      }
    }
  } finally {
    active = false;
  }
}
