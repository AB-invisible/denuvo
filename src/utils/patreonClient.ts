/**
 * patreonClient.ts — thin wrapper around the Patreon API v2
 * (https://docs.patreon.com/) for the bronze/silver/gold Discord role sync.
 *
 * Auth: a single Creator's Access Token (Platform Portal → your client →
 * "Creator's Access Token"). No OAuth dance needed since we only ever read
 * OUR OWN campaign's membership — see .env.example for setup steps.
 *
 * We deliberately do NOT trust the body of incoming webhooks for the actual
 * role decision (Patreon's `social_connections` field on the included User
 * resource has been unreliable inside webhook payloads in the wild). Instead
 * the webhook is just a "wake up and re-check this member" signal — every
 * sync (webhook-triggered or periodic) re-fetches the member fresh from the
 * API via fetchCampaignMember()/fetchCampaignMembers() below, which is the
 * only place we read social_connections from.
 */

import crypto from 'crypto';
import { CONFIG } from '../config';

const API_BASE = 'https://www.patreon.com/api/oauth2/v2';

// Fields kept minimal on purpose — every extra field is another thing that
// can be missing/renamed by Patreon and break parsing.
const MEMBER_FIELDS = 'patron_status,currently_entitled_amount_cents,last_charge_status,full_name';
const TIER_FIELDS = 'title,amount_cents';
const USER_FIELDS = 'social_connections';

export interface PatreonApiMember {
  /** Patreon's own member UUID — stable identity for a patron on this campaign. */
  id: string;
  fullName: string;
  patronStatus: 'active_patron' | 'declined_patron' | 'former_patron' | null;
  currentlyEntitledAmountCents: number | null;
  /** Patreon Tier IDs this member currently has access to (usually 0 or 1). */
  tierIds: string[];
  /** Discord user ID from the patron's Patreon "Connected Accounts", if linked. */
  discordId: string | null;
  patreonUserId: string | null;
}

function accessToken(): string {
  return (CONFIG.PATREON_ACCESS_TOKEN || '').trim();
}

export function isPatreonConfigured(): boolean {
  return Boolean(accessToken() && (CONFIG.PATREON_CAMPAIGN_ID || '').trim());
}

async function apiRequest<T>(path: string): Promise<T> {
  const token = accessToken();
  if (!token) throw new Error('PATREON_ACCESS_TOKEN is not configured');

  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* fall through — data stays null, error path below handles it */
  }

  if (!res.ok) {
    const msg = data?.errors?.[0]?.detail || text.slice(0, 300) || res.statusText;
    throw new Error(`Patreon API ${path} failed: HTTP ${res.status} — ${msg}`);
  }
  if (!data) throw new Error(`Patreon API ${path} returned a non-JSON response`);
  return data as T;
}

/** Normalizes one JSON:API "member" resource + its included user/tiers into a flat PatreonApiMember. */
function normalizeMember(memberRes: any, included: any[]): PatreonApiMember {
  const attrs = memberRes.attributes || {};
  const tierRefs: Array<{ id: string; type: string }> = memberRes.relationships?.currently_entitled_tiers?.data || [];
  const userRef = memberRes.relationships?.user?.data;

  const includedById = new Map<string, any>();
  for (const inc of included || []) {
    includedById.set(`${inc.type}:${inc.id}`, inc);
  }

  let discordId: string | null = null;
  let patreonUserId: string | null = null;
  if (userRef?.id) {
    patreonUserId = String(userRef.id);
    const userRes = includedById.get(`user:${userRef.id}`);
    const social = userRes?.attributes?.social_connections;
    const discordUserId = social?.discord?.user_id;
    if (discordUserId) discordId = String(discordUserId);
  }

  return {
    id: String(memberRes.id),
    fullName: String(attrs.full_name || ''),
    patronStatus: attrs.patron_status ?? null,
    currentlyEntitledAmountCents: typeof attrs.currently_entitled_amount_cents === 'number' ? attrs.currently_entitled_amount_cents : null,
    tierIds: tierRefs.map((t) => String(t.id)),
    discordId,
    patreonUserId,
  };
}

/**
 * Paginates through every member on the campaign. Patreon caps pages at
 * 1000 results; we follow meta.pagination.cursors.next until it's absent.
 */
export async function fetchCampaignMembers(): Promise<PatreonApiMember[]> {
  const campaignId = (CONFIG.PATREON_CAMPAIGN_ID || '').trim();
  if (!campaignId) throw new Error('PATREON_CAMPAIGN_ID is not configured');

  const members: PatreonApiMember[] = [];
  let cursor: string | null = null;

  do {
    const params = new URLSearchParams({
      include: 'currently_entitled_tiers,user',
      'fields[member]': MEMBER_FIELDS,
      'fields[tier]': TIER_FIELDS,
      'fields[user]': USER_FIELDS,
      'page[count]': '1000',
    });
    if (cursor) params.set('page[cursor]', cursor);

    const data = await apiRequest<any>(`/campaigns/${encodeURIComponent(campaignId)}/members?${params.toString()}`);
    const page: any[] = Array.isArray(data.data) ? data.data : [];
    const included: any[] = Array.isArray(data.included) ? data.included : [];
    for (const m of page) members.push(normalizeMember(m, included));

    cursor = data.meta?.pagination?.cursors?.next || null;
  } while (cursor);

  return members;
}

/** Fetch a single member fresh by ID — used by the webhook handler so we never trust webhook body content directly. */
export async function fetchCampaignMember(memberId: string): Promise<PatreonApiMember> {
  const params = new URLSearchParams({
    include: 'currently_entitled_tiers,user',
    'fields[member]': MEMBER_FIELDS,
    'fields[tier]': TIER_FIELDS,
    'fields[user]': USER_FIELDS,
  });
  const data = await apiRequest<any>(`/members/${encodeURIComponent(memberId)}?${params.toString()}`);
  return normalizeMember(data.data, data.included || []);
}

/**
 * Verifies X-Patreon-Signature: hex digest of the RAW request body,
 * HMAC'd with MD5 using the webhook secret. Must be called with the raw
 * (unparsed) body buffer/string — parsing and re-stringifying JSON would
 * produce a different byte sequence and always fail verification.
 */
export function verifyPatreonWebhookSignature(rawBody: string | Buffer, signatureHeader: string | undefined): boolean {
  const secret = (CONFIG.PATREON_WEBHOOK_SECRET || '').trim();
  if (!secret || !signatureHeader) return false;

  const expected = crypto.createHmac('md5', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHeader.trim(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Extracts the member id + trigger event from a (signature-verified) webhook body. Best-effort only — the actual sync always re-fetches from the API. */
export function parsePatreonWebhookMemberId(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody);
    const id = parsed?.data?.id;
    return id ? String(id) : null;
  } catch {
    return null;
  }
}
