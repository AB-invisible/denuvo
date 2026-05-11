import { Client, GatewayIntentBits, Collection, Partials } from 'discord.js';
import { CONFIG } from './config';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    // Required for the MessageReactionAdd event (vouch verification via ❤️)
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [
    Partials.GuildMember,
    Partials.User,
    Partials.Message,
    Partials.Channel,
    // Required so reactions on uncached (older) messages still fire the event
    Partials.Reaction,
  ],
});

export { client };
