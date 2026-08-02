#!/usr/bin/env node
/**
 * Build dist/render-env.txt from .env for Render dashboard Environment tab.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const OUT = path.join(ROOT, 'dist', 'render-env.txt');

const KEYS = [
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
  'PATREON_ACCESS_TOKEN',
  'PATREON_CAMPAIGN_ID',
  'PATREON_WEBHOOK_SECRET',
  'PATREON_TIER_BRONZE_ID',
  'PATREON_TIER_SILVER_ID',
  'PATREON_TIER_GOLD_ID',
  'PATREON_SYNC_INTERVAL_MINUTES',
  'PATREON_CLIENT_ID',
  'PATREON_CLIENT_SECRET',
];

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
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

const env = fs.existsSync(ENV_PATH) ? parseEnv(fs.readFileSync(ENV_PATH, 'utf8')) : {};

const lines = [
  '# Paste into Render → denuvo-bot → Environment',
  '# DATABASE_URL is wired automatically when you use render.yaml + Postgres',
  '# RENDER_EXTERNAL_URL is set by Render — do not paste it manually',
  '# After first deploy, set PATREON_REDIRECT_URI to:',
  '#   https://YOUR-SERVICE.onrender.com/patreon/oauth/callback',
  '',
  'NODE_ENV=production',
  '',
];

for (const key of KEYS) {
  if (env[key]) lines.push(`${key}=${env[key]}`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log('Wrote', OUT);
