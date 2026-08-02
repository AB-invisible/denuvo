#!/usr/bin/env node
/**
 * Deploy denuvo stack to Render via Blueprint API + env injection.
 *
 * Requires in .env:
 *   RENDER_API_KEY=rnd_...  (from https://dashboard.render.com/u/settings#api-keys)
 *
 * Usage: node scripts/setup-render.js [--dry-run]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = 'https://api.render.com/v1';
const DRY = process.argv.includes('--dry-run');

const ENV_KEYS = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'GUILD_ID',
  'OWNER_GUILD_ID',
  'OWNER_ROLE_ID',
  'SUPER_OWNER_IDS',
  'STAFF_ROLE_ID',
  'DONATOR_ROLE_ID',
  'BRONZE_ROLE_ID',
  'SILVER_ROLE_ID',
  'GOLD_ROLE_ID',
  'ACTIVATORS_ROLE_ID',
  'TICKET_CATEGORY_ID',
  'LOG_CHANNEL_ID',
  'STOCK_NOTIF_CHANNEL_ID',
  'VOUCHER_CHANNEL_ID',
  'GUIDE_CHANNEL_ID',
  'BOT_NAME',
  'PATREON_URL',
  'STEAMPASS_DISABLED',
  'STEAMAUTH_API_URL',
  'STEAMAUTH_API_KEY',
  'UBISOFT_SERVICE_URL',
  'UBISOFT_SERVICE_KEY',
  'EA_SERVICE_URL',
  'EA_SERVICE_KEY',
  'GROQ_API_KEY',
  'GROQ_MODEL',
  'HMAC_SECRET',
  'INSTALLER_CALLHOME',
  'SELF_HOSTED_DOWNLOADS',
  'PATREON_ACCESS_TOKEN',
  'PATREON_CAMPAIGN_ID',
  'PATREON_WEBHOOK_SECRET',
  'PATREON_TIER_BRONZE_ID',
  'PATREON_TIER_SILVER_ID',
  'PATREON_TIER_GOLD_ID',
  'PATREON_TIER_BYPASS_ID',
  'PATREON_SYNC_INTERVAL_MINUTES',
  'PATREON_CLIENT_ID',
  'PATREON_CLIENT_SECRET',
];

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function cloudifyLocalUrls(env) {
  const out = { ...env };
  // Render cannot reach localhost — keep Railway/cloud URLs only.
  for (const key of ['EA_SERVICE_URL', 'UBISOFT_SERVICE_URL', 'PUBLIC_URL']) {
    const v = (out[key] || '').trim();
    if (!v || /127\.0\.0\.1|localhost/i.test(v)) delete out[key];
  }
  for (const key of ['EA_MAGIC_DIR', 'UBISOFT_MAGIC_DIR']) {
    const v = (out[key] || '').trim();
    if (v && /^[A-Za-z]:\\/.test(v)) delete out[key];
  }
  out.NODE_ENV = 'production';
  return out;
}

async function api(method, pathSuffix, body) {
  const key = process.env.RENDER_API_KEY?.trim();
  if (!key) throw new Error('RENDER_API_KEY missing in .env');
  const res = await fetch(`${API}${pathSuffix}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Render API ${method} ${pathSuffix} → ${res.status}: ${text.slice(0, 500)}`);
  }
  return json;
}

async function listServices() {
  const json = await api('GET', '/services?limit=100');
  return json || [];
}

async function findService(name) {
  const services = await listServices();
  return services.find((s) => s.service?.name === name || s.name === name)?.service
    || services.find((s) => s.service?.name === name)?.service
    || services.find((s) => s.name === name);
}

async function patchServiceEnv(serviceId, envVars) {
  const payload = envVars.map(({ key, value }) => ({ key, value }));
  return api('PATCH', `/services/${serviceId}/env-vars`, payload);
}

async function triggerDeploy(serviceId) {
  return api('POST', `/services/${serviceId}/deploys`, { clearCache: false });
}

async function main() {
  console.log('[setup-render] Reading local .env...');
  const localEnv = cloudifyLocalUrls(parseEnvFile(path.join(ROOT, '.env')));
  const envVars = ENV_KEYS.filter((k) => localEnv[k]).map((k) => ({ key: k, value: localEnv[k] }));

  if (!localEnv.DISCORD_TOKEN) {
    throw new Error('DISCORD_TOKEN missing in .env');
  }

  if (!process.env.RENDER_API_KEY?.trim()) {
    console.error('');
    console.error('Add a Render API key to .env first:');
    console.error('  1. https://dashboard.render.com/u/settings#api-keys → Create API Key');
    console.error('  2. RENDER_API_KEY=rnd_... in .env');
    console.error('  3. Re-run: node scripts/setup-render.js');
    console.error('');
    console.error('Also push render.yaml to GitHub, then New → Blueprint in Render if not done yet.');
    process.exit(1);
  }

  console.log('[setup-render] Validating render.yaml...');
  const yaml = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  if (DRY) {
    console.log('[setup-render] dry-run — would inject', envVars.length, 'env vars');
    return;
  }

  try {
    await api('POST', '/blueprints/validate', { blueprint: yaml });
    console.log('[setup-render] render.yaml validates OK');
  } catch (e) {
    console.warn('[setup-render] Blueprint validate skipped/failed:', e.message);
  }

  let service = await findService('denuvo-bot');
  if (!service) {
    console.log('[setup-render] denuvo-bot not found yet.');
    console.log('Create it via Render Dashboard → New → Blueprint → connect GitHub repo.');
    console.log('Then re-run this script to inject environment variables.');
    process.exit(2);
  }

  console.log(`[setup-render] Patching env on service ${service.id} (${service.name})...`);
  await patchServiceEnv(service.id, envVars);
  console.log(`[setup-render] Set ${envVars.length} environment variables.`);

  console.log('[setup-render] Triggering deploy...');
  await triggerDeploy(service.id);
  console.log('[setup-render] Deploy triggered.');

  const url = service.serviceDetails?.url || service.url;
  if (url) {
    console.log(`[setup-render] Service URL: ${url}`);
    console.log(`[setup-render] Set PATREON_REDIRECT_URI=${url}/patreon/oauth/callback`);
  }

  console.log('[setup-render] Stopping local Windows bot services...');
  if (process.platform === 'win32') {
    spawnSync('powershell', [
      '-NoProfile',
      '-Command',
      "Stop-Service denuvo-bot,denuvo-tunnel -ErrorAction SilentlyContinue; Get-Service denuvo-bot,denuvo-tunnel -ErrorAction SilentlyContinue | Format-Table Name,Status",
    ], { stdio: 'inherit' });
  }

  console.log('[setup-render] Done.');
}

main().catch((err) => {
  console.error('[setup-render] FAILED:', err.message || err);
  process.exit(1);
});
