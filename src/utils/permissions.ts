import { GuildMember } from 'discord.js';
import { CONFIG } from '../config';

/**
 * Utility class for centralized permission and role checking.
 * Centralizing this ensures consistent behavior and easier maintenance
 * as roles change or new membership tiers are added.
 */

let warnedStaffEmpty = false;
let warnedDonatorEmpty = false;

// Synchronous staff check. Used widely (claim/close/etc.) where awaiting a
// DB lookup per call would be awkward. It returns true if EITHER:
//   - the member has the global home STAFF_ROLE_ID (home server), OR
//   - the member has Discord's ManageGuild/Administrator permission.
// The second clause is what makes BUYER-SERVER staff work without threading
// an async per-guild role lookup through every call site: a buyer server's
// admins/mods (who hold ManageGuild) are treated as staff. For an exact
// per-server staff ROLE match, use isStaffForGuild() below.
export function isStaff(member: GuildMember): boolean {
  if (!member || !member.roles) return false;
  // Discord-native elevated permission → staff in any guild.
  try {
    if (member.permissions?.has?.('ManageGuild') || member.permissions?.has?.('Administrator')) {
      return true;
    }
  } catch { /* permissions may be a partial in rare cases — fall through */ }
  if (CONFIG.STAFF_ROLE_ID && member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return true;
  return false;
}

/**
 * Exact per-server staff check — matches the tenant's configured staffRoleId
 * (or the global env role on the home server), PLUS the ManageGuild/Admin
 * fallback. Async because it resolves tenant config. Use this where you have
 * the guild and want the buyer's OWN staff role honored precisely.
 */
export async function isStaffForGuild(member: GuildMember, guildId: string): Promise<boolean> {
  if (!member || !member.roles) return false;
  try {
    if (member.permissions?.has?.('ManageGuild') || member.permissions?.has?.('Administrator')) {
      return true;
    }
  } catch {}
  try {
    const { resolveServerConfig } = await import('./tenant');
    const sc = await resolveServerConfig(guildId);
    if (sc.staffRoleId && member.roles.cache.has(sc.staffRoleId)) return true;
    if (sc.activatorsRoleId && member.roles.cache.has(sc.activatorsRoleId)) return true;
  } catch { /* fall back to the global role below */ }
  if (CONFIG.STAFF_ROLE_ID && member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return true;
  return false;
}

export function isDonator(member: GuildMember): boolean {
  if (!member || !member.roles) return false;
  if (!CONFIG.DONATOR_ROLE_ID) {
    if (!warnedDonatorEmpty) {
      console.warn('[permissions] DONATOR_ROLE_ID is empty — isDonator() will always return false.');
      warnedDonatorEmpty = true;
    }
    return false;
  }
  return member.roles.cache.has(CONFIG.DONATOR_ROLE_ID);
}

export function getTier(member: GuildMember): 'Gold' | 'Silver' | 'Bronze' | 'None' {
  if (!member || !member.roles) return 'None';
  
  const roles = member.roles.cache;
  if (roles.has(CONFIG.GOLD_ROLE_ID)) return 'Gold';
  if (roles.has(CONFIG.SILVER_ROLE_ID)) return 'Silver';
  if (roles.has(CONFIG.BRONZE_ROLE_ID)) return 'Bronze';
  
  return 'None';
}

export function hasPermissionLevel(member: GuildMember, level: 'STAFF' | 'DONATOR' | 'USER'): boolean {
  if (level === 'STAFF') return isStaff(member);
  if (level === 'DONATOR') return isDonator(member) || isStaff(member); // Staff are usually treated as "super-donators"
  return true; // Everyone is a USER
}
