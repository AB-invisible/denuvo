import { GuildMember } from 'discord.js';
import { CONFIG } from '../config';

/**
 * Utility class for centralized permission and role checking.
 * Centralizing this ensures consistent behavior and easier maintenance
 * as roles change or new membership tiers are added.
 */

export function isStaff(member: GuildMember): boolean {
  if (!member || !member.roles) return false;
  return member.roles.cache.has(CONFIG.STAFF_ROLE_ID);
}

export function isDonator(member: GuildMember): boolean {
  if (!member || !member.roles) return false;
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
