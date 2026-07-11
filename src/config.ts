import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  TOKEN: process.env.DISCORD_TOKEN || '',
  CLIENT_ID: process.env.CLIENT_ID || '',
  GUILD_ID: process.env.GUILD_ID || '',
  OWNER_GUILD_ID: process.env.OWNER_GUILD_ID || process.env.GUILD_ID || '1205897412502224947',
  OWNER_ROLE_ID: process.env.OWNER_ROLE_ID || '1495828353649999984',
  OWNER_TOKENS_PER_ACCOUNT_PER_DAY: process.env.OWNER_TOKENS_PER_ACCOUNT_PER_DAY !== undefined ? Number(process.env.OWNER_TOKENS_PER_ACCOUNT_PER_DAY) : 5,
  // Minutes the steampass circuit breaker stays open after a 429/403 throttle.
  // While open, gens only use the free cached refresh_token path (no steampass
  // calls) so we stop hammering a rate-limited / banned endpoint.
  STEAMPASS_COOLDOWN_MINUTES: process.env.STEAMPASS_COOLDOWN_MINUTES !== undefined ? Number(process.env.STEAMPASS_COOLDOWN_MINUTES) : 20,
  // Minimum gap (ms) between two steampass-touching gens. Serializes + spaces
  // steampass calls to human cadence so we never burst the endpoint. Gens that
  // reuse a cached refresh_token bypass this (they make no steampass calls).
  STEAMPASS_MIN_GAP_MS: process.env.STEAMPASS_MIN_GAP_MS !== undefined ? Number(process.env.STEAMPASS_MIN_GAP_MS) : 4000,
  // Max steampass pool accounts a single failed gen will rotate through before
  // giving up. Caps the burst one bad game can cause (each account = a full
  // steampass login flow). refresh_token/owned/steamauth attempts don't count.
  STEAMPASS_MAX_ACCOUNTS_PER_GEN: process.env.STEAMPASS_MAX_ACCOUNTS_PER_GEN !== undefined ? Number(process.env.STEAMPASS_MAX_ACCOUNTS_PER_GEN) : 2,
  // Hard ceiling on steampass API calls per UTC day (login + profile + guard).
  // Once hit, only refresh_token gens run until midnight UTC.
  STEAMPASS_DAILY_BUDGET: process.env.STEAMPASS_DAILY_BUDGET !== undefined ? Number(process.env.STEAMPASS_DAILY_BUDGET) : 80,
  // When true (default), steampass.gg is never called — autogen uses SteamAuth
  // and BYO owned accounts only. Set STEAMPASS_DISABLED=false to re-enable.
  STEAMPASS_DISABLED: process.env.STEAMPASS_DISABLED !== 'false',
  STAFF_ROLE_ID: process.env.STAFF_ROLE_ID || '1484195272270811226',
  DONATOR_ROLE_ID: process.env.DONATOR_ROLE_ID || '1485995423633117224',
  BRONZE_ROLE_ID: process.env.BRONZE_ROLE_ID || '1486006821775872222',
  SILVER_ROLE_ID: process.env.SILVER_ROLE_ID || '1486006856664223846',
  GOLD_ROLE_ID: process.env.GOLD_ROLE_ID || '1486006880940855357',
  PATREON_URL: process.env.PATREON_URL || 'https://www.patreon.com/14456576/join',
  TICKET_CATEGORY_ID: process.env.TICKET_CATEGORY_ID || '',
  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || '1487740605072412682',
  STOCK_NOTIF_CHANNEL_ID: process.env.STOCK_NOTIF_CHANNEL_ID || '1476858321846800586',
  VOUCHER_CHANNEL_ID: process.env.VOUCHER_CHANNEL_ID || '1483761896103608450',
  ACTIVATORS_ROLE_ID: process.env.ACTIVATORS_ROLE_ID || process.env.STAFF_ROLE_ID || '1484195272270811226',
  DATABASE_URL: process.env.DATABASE_URL || '',
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  NAME: process.env.BOT_NAME || 'GameGen',
  TIER_COOLDOWNS: {
    GOLD: process.env.COOLDOWN_GOLD !== undefined ? Number(process.env.COOLDOWN_GOLD) : 8,
    SILVER: process.env.COOLDOWN_SILVER !== undefined ? Number(process.env.COOLDOWN_SILVER) : 16,
    BRONZE: process.env.COOLDOWN_BRONZE !== undefined ? Number(process.env.COOLDOWN_BRONZE) : 20,
    NONE: process.env.COOLDOWN_NONE !== undefined ? Number(process.env.COOLDOWN_NONE) : 24,
    DEFAULT: process.env.COOLDOWN_DEFAULT !== undefined ? Number(process.env.COOLDOWN_DEFAULT) : 8760 * 10
  },
  DUTY_RESET_HOURS: process.env.DUTY_RESET_HOURS !== undefined ? Number(process.env.DUTY_RESET_HOURS) : 8,
  /** Fraction of a game's stock reserved for FIFO queue slots (rest is open to everyone). */
  QUEUE_RESERVE_RATIO: process.env.QUEUE_RESERVE_RATIO !== undefined ? Number(process.env.QUEUE_RESERVE_RATIO) : 0.30,
  STEAMAUTH_API_URL: process.env.STEAMAUTH_API_URL || 'https://steamauth.gamegen.lol',
  STEAMAUTH_API_KEY: process.env.STEAMAUTH_API_KEY || '',
  // ── Ubisoft token-minting service (ubisoft-service/) ──
  // The bot POSTs {ubisoftAppId, ticket} to UBISOFT_SERVICE_URL/ubisoft/token
  // with X-Api-Key: UBISOFT_SERVICE_KEY and gets back {token, ownership}.
  UBISOFT_SERVICE_URL: process.env.UBISOFT_SERVICE_URL || '',
  UBISOFT_SERVICE_KEY: process.env.UBISOFT_SERVICE_KEY || '',
  // Directory the payload server streams magic-files zips from. Populate it
  // with the "* Magic Files.zip" files (e.g. a Railway volume).
  UBISOFT_MAGIC_DIR: process.env.UBISOFT_MAGIC_DIR || '',
};
