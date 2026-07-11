/**
 * eaService.ts — client for the EA token-minting service (ea-service/, POST /ea/token).
 *
 * The Windows sidecar runs EAtoken_generator.exe with stored EA remid/signature
 * cookies. This module sends the user's Denuvo ticket and returns { token }.
 */

import { CONFIG } from '../config';

export interface EaMintSuccess {
  ok: true;
  token: string;
  usedContentId: number;
  usedEngine: string;
}

export interface EaMintFailure {
  ok: false;
  code: string;
  error: string;
  logs?: string;
  usedContentId?: number;
  usedEngine?: string;
}

export type EaMintResult = EaMintSuccess | EaMintFailure;

export function eaServiceConfigured(): boolean {
  return Boolean((CONFIG.EA_SERVICE_URL || '').trim() && (CONFIG.EA_SERVICE_KEY || '').trim());
}

function serviceBase(): string {
  return (CONFIG.EA_SERVICE_URL || '').trim().replace(/\/+$/, '');
}

interface RawServiceResponse {
  token?: string;
  error?: string;
  code?: string;
  logs?: string;
  detail?: string | RawServiceResponse;
}

function unwrapBody(body: RawServiceResponse): RawServiceResponse {
  if (body.detail && typeof body.detail === 'object') return body.detail;
  if (typeof body.detail === 'string') return { error: body.detail };
  return body;
}

export async function mintEaToken(
  ticket: string,
  contentId: number,
  engine: string,
): Promise<EaMintResult> {
  if (!eaServiceConfigured()) {
    return { ok: false, code: 'NotConfigured', error: 'EA_SERVICE_URL / EA_SERVICE_KEY not set' };
  }

  const payload = { ticket: ticket.trim(), contentId, engine };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150_000);

  try {
    const res = await fetch(`${serviceBase()}/ea/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Api-Key': (CONFIG.EA_SERVICE_KEY || '').trim(),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await res.text();
    let body: RawServiceResponse = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: text.slice(0, 300) };
    }
    body = unwrapBody(body);

    if (res.ok && body.token) {
      return { ok: true, token: body.token, usedContentId: contentId, usedEngine: engine };
    }

    return {
      ok: false,
      code: body.code || (res.status === 504 ? 'Timeout' : res.status === 503 ? 'ServiceUnavailable' : 'Failure'),
      error: body.error || `service returned HTTP ${res.status}`,
      logs: body.logs,
      usedContentId: contentId,
      usedEngine: engine,
    };
  } catch (e) {
    return { ok: false, code: 'ServiceUnavailable', error: (e as Error).message, usedContentId: contentId, usedEngine: engine };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkEaServiceHealth(): Promise<{ ok: boolean; tool?: boolean; configured?: boolean; error?: string }> {
  if (!eaServiceConfigured()) return { ok: false, error: 'not configured' };
  try {
    const res = await fetch(`${serviceBase()}/health`, { headers: { Accept: 'application/json' } });
    const body: any = await res.json().catch(() => ({}));
    return { ok: res.ok && body?.ok === true, tool: body?.tool, configured: body?.configured };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
