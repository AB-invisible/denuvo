import { CONFIG } from '../config';

const SUPER_OWNER_ID_SET = new Set(
  (process.env.SUPER_OWNER_IDS || '763912131153887264')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
);

/** Bot owner user IDs — full owner command access in any server the bot is in. */
export function isSuperOwner(userId: string | null | undefined): boolean {
  return !!userId && SUPER_OWNER_ID_SET.has(userId);
}

/** Owner home server, or a super-owner in any authorized server. */
export function allowsOwnerOnlyCommand(interaction: {
  user: { id: string };
  guildId?: string | null;
}): boolean {
  if (isSuperOwner(interaction.user.id)) return true;
  return interaction.guildId === CONFIG.OWNER_GUILD_ID;
}
