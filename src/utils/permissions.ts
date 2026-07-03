import { GuildMember } from 'discord.js';
import { CONFIG } from '../config';

let warnedStaffEmpty = false;
let warnedDonatorEmpty = false;

export function isStaff(member: GuildMember): boolean {
  if (!member || !member.roles) return false;
  try {
    if (member.permissions?.has?.('ManageGuild') || member.permissions?.has?.('Administrator')) {
      return true;
    }
  } catch {}
  if (CONFIG.STAFF_ROLE_ID && member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return true;
  return false;
}

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
  } catch {}
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

export async function isDonatorForGuild(member: GuildMember, guildId: string): Promise<boolean> {
  if (!member || !member.roles) return false;
  try {
    const { resolveServerConfig } = await import('./tenant');
    const sc = await resolveServerConfig(guildId);
    if (sc.donatorRoleId && member.roles.cache.has(sc.donatorRoleId)) return true;
  } catch {}
  return isDonator(member);
}

export function getTier(member: GuildMember): 'Gold' | 'Silver' | 'Bronze' | 'None' {
  if (!member || !member.roles) return 'None';

  const roles = member.roles.cache;
  if (roles.has(CONFIG.GOLD_ROLE_ID)) return 'Gold';
  if (roles.has(CONFIG.SILVER_ROLE_ID)) return 'Silver';
  if (roles.has(CONFIG.BRONZE_ROLE_ID)) return 'Bronze';

  return 'None';
}

export async function getTierForGuild(member: GuildMember, guildId: string): Promise<'Gold' | 'Silver' | 'Bronze' | 'None'> {
  if (!member || !member.roles) return 'None';
  try {
    const { resolveServerConfig } = await import('./tenant');
    const sc = await resolveServerConfig(guildId);
    const roles = member.roles.cache;
    if (sc.goldRoleId && roles.has(sc.goldRoleId)) return 'Gold';
    if (sc.silverRoleId && roles.has(sc.silverRoleId)) return 'Silver';
    if (sc.bronzeRoleId && roles.has(sc.bronzeRoleId)) return 'Bronze';
  } catch {}
  return getTier(member);
}

export function hasPermissionLevel(member: GuildMember, level: 'STAFF' | 'DONATOR' | 'USER'): boolean {
  if (level === 'STAFF') return isStaff(member);
  if (level === 'DONATOR') return isDonator(member) || isStaff(member);
  return true;
}
