import { GuildMember } from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { getTierForGuild, isDonatorForGuild } from './permissions';

export const HIGH_DEMAND_COOLDOWN_HOURS = 48;
export const DONATOR_ONLY_GAME_COOLDOWN_HOURS = 2;

export interface GameCooldownFlags {
  highDemand?: boolean;
  donatorOnly?: boolean;
}

export interface CooldownResult {
  /** Cooldown length in hours to apply after a successful token gen. */
  hours: number;
  /** The effective tier used ('Gold' | 'Silver' | 'Bronze' | 'None', or a promo grant). */
  tier: string;
  /** True when an active temp_tier promo upgraded the user's tier. */
  viaPromo: boolean;
  /** True when a high-demand game forced 48h for a non-donor. */
  highDemandApplied?: boolean;
}

/**
 * Single source of truth for the post-gen cooldown a user gets.
 *
 * Resolves the user's membership tier (Gold/Silver/Bronze/None) for the
 * given guild, then lets an active `temp_tier` promo redemption upgrade it
 * if the promo grants a HIGHER tier than they already have. The final tier
 * maps to CONFIG.TIER_COOLDOWNS.
 *
 * Game overrides (applied after tier):
 *   • donatorOnly games → 2h for everyone
 *   • highDemand games → 48h for non-donors; donors keep their tier cooldown
 *
 * Every close path (staff /close, vouch auto-close, reaction close) must
 * call this so members and promo codes get the SAME cooldown everywhere —
 * previously only staff /close honored tiers/promos, and the normal vouch
 * flow silently fell back to a flat game-tier cooldown, making paid perks
 * and /redeem codes do nothing on the main path.
 */
export async function computeCooldownHours(
  member: GuildMember | null | undefined,
  userId: string,
  guildId: string,
  game?: GameCooldownFlags | null,
): Promise<CooldownResult> {
  let tier: string = member ? await getTierForGuild(member, guildId) : 'None';
  let viaPromo = false;

  const promoTier = await prisma.promoRedemption.findFirst({
    where: { userId, guildId, expiresAt: { gt: new Date() } },
    include: { promo: true },
    orderBy: { expiresAt: 'desc' },
  });
  if (promoTier?.promo.effect === 'temp_tier' && promoTier.promo.tierGrant) {
    const tierRank: Record<string, number> = { Gold: 3, Silver: 2, Bronze: 1, None: 0 };
    if ((tierRank[promoTier.promo.tierGrant] || 0) > (tierRank[tier] || 0)) {
      tier = promoTier.promo.tierGrant;
      viaPromo = true;
    }
  }

  let hours =
    CONFIG.TIER_COOLDOWNS[tier.toUpperCase() as keyof typeof CONFIG.TIER_COOLDOWNS] ??
    CONFIG.TIER_COOLDOWNS.DEFAULT;

  let highDemandApplied = false;

  if (game?.donatorOnly) {
    hours = DONATOR_ONLY_GAME_COOLDOWN_HOURS;
  } else if (game?.highDemand) {
    const donor = member ? await isDonatorForGuild(member, guildId) : false;
    if (!donor) {
      hours = HIGH_DEMAND_COOLDOWN_HOURS;
      highDemandApplied = true;
    }
  }

  return { hours, tier, viaPromo, highDemandApplied };
}
