import { Client, GatewayIntentBits, Collection, Partials } from 'discord.js';
import { CONFIG } from './config';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.GuildMember, Partials.User, Partials.Message, Partials.Channel],
});

export { client };
