import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  TOKEN: process.env.DISCORD_TOKEN || '',
  CLIENT_ID: process.env.CLIENT_ID || '',
  GUILD_ID: process.env.GUILD_ID || '',
  OWNER_GUILD_ID: process.env.OWNER_GUILD_ID || process.env.GUILD_ID || '1205897412502224947',
  OWNER_ROLE_ID: process.env.OWNER_ROLE_ID || '1495828353649999984',
  OWNER_TOKENS_PER_ACCOUNT_PER_DAY: process.env.OWNER_TOKENS_PER_ACCOUNT_PER_DAY !== undefined ? Number(process.env.OWNER_TOKENS_PER_ACCOUNT_PER_DAY) : 5,
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
  DUTY_RESET_HOURS: process.env.DUTY_RESET_HOURS !== undefined ? Number(process.env.DUTY_RESET_HOURS) : 8
};
