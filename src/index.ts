import { client } from './client';
import { CONFIG } from './config';
import { commandHandlers } from './commands';
import path from 'path';
import { REST, Routes, InteractionType, PermissionsBitField, PermissionFlagsBits, SlashCommandBuilder, TextChannel, AttachmentBuilder, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType, MessageFlags, EmbedBuilder, Message, GuildMember, Guild } from 'discord.js';
import { createMainPanel, createVerificationPromptEmbed, createVerificationProcessingEmbed, createVerificationSuccessEmbed, createVerificationFailureEmbed, createTokenDeliveryEmbed, createVouchRequestEmbed } from './utils/embeds';
import { createTicket, claimTicket, closeTicket, handleCooldownSelection, handleDeductionChoice, unclaimTicket, autoCloseTicketForVerificationTimeout, triggerSessionFailure, pendingVerificationTimers, vouchTimers } from './utils/ticketManager';
import { getEstimatedWaitTime } from './utils/stats';
import { consumeStock } from './utils/gameManager';
import prisma from './lib/prisma';
import { logAction } from './utils/logging';
import { refreshAllPanels, resumeFromMaintenance } from './utils/panelManager';
import { verifyScreenshot, VERIFY_BYPASS_REASON } from './utils/groq';
import { initFileWatcher, syncGamesFromFile } from './utils/syncManager';
import { generateToken } from './utils/tokenGenerator';
import { uploadFile } from './utils/fileHost';
import { updateTicketWaitTimes, checkWeeklyStaffStats, checkDutyStatusReset, checkStaleTickets, cleanupExpiredCooldowns } from './utils/scheduler';
import { addSubscription } from './utils/subscriptionManager';
import { logTenant } from './utils/logging';
import { checkGuild, shouldLeaveGuild } from './utils/guildAccess';
import { getAllowedGuildIds, invalidateTenantCache } from './utils/tenant';
import { pickOwnerAccount, recordOwnerUsage } from './utils/steampassPool';
import { OWNER_COMMANDS, SETLOGS_COMMAND, SETVOUCH_COMMAND, ADDSUPPORT_COMMAND, OWNER_COMMAND_NAMES, handleTenantCommand } from './utils/tenantCommands';
// Spin up the payload HTTP server immediately so Railway's PORT-based
// healthcheck has something to talk to even before the Discord client
// finishes connecting. Wrapped in dynamic import + try/catch so any
// error inside it (DB connection, port binding, etc.) can NEVER take
// the Discord bot down with it — the worst case is installer downloads
// won't work for a deploy.
(async () => {
  try {
    const mod = await import('./payloadServer');
    mod.startPayloadServer();
  } catch (e) {
    console.error('[PayloadServer] failed to start, continuing without it:', e);
  }
})();

const commands = [
  new SlashCommandBuilder()
    .setName('postpanel')
    .setDescription('Post the GameGen Selection Panel')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('closepanel')
    .setDescription('Closes the current panel and puts it into maintenance mode')
    .addIntegerOption(o => o.setName('duration').setDescription('Duration in minutes to stay in maintenance mode before auto-restarting').setRequired(false))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('stock')
    .setDescription('Manage game stock')
    .addSubcommand(sub => sub.setName('add').setDescription('Add stock to a game').addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true).setAutocomplete(true)).addIntegerOption(o => o.setName('amount').setDescription('Amount to add').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Remove stock from a game').addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true).setAutocomplete(true)).addIntegerOption(o => o.setName('amount').setDescription('Amount to remove').setRequired(true)))
    .addSubcommand(sub => sub.setName('set').setDescription('Set stock for a game').addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true).setAutocomplete(true)).addIntegerOption(o => o.setName('amount').setDescription('Specific amount to set').setRequired(true)))
    .addSubcommand(sub => sub.setName('clear').setDescription('Clear stock for a game').addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true).setAutocomplete(true)))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('cooldown')
    .setDescription('Manage user cooldowns')
    .addSubcommand(sub => sub.setName('remove').setDescription('Remove cooldown from a user').addUserOption(o => o.setName('user').setDescription('The user to remove cooldown from').setRequired(true)))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  // Top-level convenience aliases for /game delete and /stock set so admins
  // don't have to remember the subcommand path.
  new SlashCommandBuilder()
    .setName('removegame')
    .setDescription('Remove a manually-added game from the panel (alias of /game delete)')
    .addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true).setAutocomplete(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('settokens')
    .setDescription('Set how many tokens are left for a game (alias of /stock set)')
    .addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Number of tokens to set').setRequired(true).setMinValue(0))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('mycooldown')
    .setDescription('Check your current security cooldown status'),
  new SlashCommandBuilder()
    .setName('staffstats')
    .setDescription('View weekly staff performance statistics')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('onduty')
    .setDescription('Toggle your staff on-duty status'),
  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('View your user security profile and active cooldowns'),
  new SlashCommandBuilder()
    .setName('lookup')
    .setDescription('Look up a user\'s activation history and risk profile')
    .addUserOption(o => o.setName('user').setDescription('The user to look up').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('exclude-auto')
    .setDescription('Toggle a game\'s exclusion from automatic stock regeneration')
    .addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('state').setDescription('On = exclude from regen, Off = allow regen').setRequired(true).addChoices({ name: 'On (Exclude)', value: 'on' }, { name: 'Off (Allow Regen)', value: 'off' }))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('deplet')
    .setDescription('Bulk deplete game tokens')
    .addSubcommand(sub => sub.setName('all').setDescription('Set token count to 0 for every game'))
    .addSubcommand(sub => sub.setName('game').setDescription('Set token count to 0 for a single game').addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true).setAutocomplete(true)))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('simulate')
    .setDescription('Walk through the full user experience for a game (no tokens consumed)')
    .addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true).setAutocomplete(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('test')
    .setDescription('Generate a TEST token (fake credentials) to verify a game\'s template')
    .addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true).setAutocomplete(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('tokengen')
    .setDescription('Generate a REAL token (staff bypass, posted publicly, no screenshot needed)')
    .addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true).setAutocomplete(true))
    .addBooleanOption(o => o.setName('deduct').setDescription('Deduct one token from stock? (default: true)').setRequired(false))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('setmode')
    .setDescription('Set the token-generation mode for a game (or ALL games at once)')
    .addStringOption(o => o.setName('game').setDescription('Game name, or "ALL" to apply to every game').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('mode').setDescription('Output layout').setRequired(true).addChoices(
      { name: 'GBE Normal (flat: steam_api64 + steamclient64 + steam_settings)', value: 'gbe' },
      { name: 'ColdLoader V2 (DLL hijack via version/dinput8/winmm)', value: 'coldloader' },
      { name: 'ColdClientLoader V1 (launcher .exe) — recommended for Denuvo', value: 'coldclientloader' },
    ))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('getmode')
    .setDescription('Check the generation mode of a game (or all games grouped by mode)')
    .addStringOption(o => o.setName('game').setDescription('Game name (omit to see grouped summary of all games)').setRequired(false).setAutocomplete(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('setsteampass')
    .setDescription('Update the cached steampass.gg bearer token (replaces the auto-login flow)')
    .addStringOption(o => o.setName('token').setDescription('Bearer token from steampass.gg DevTools Network tab').setRequired(false))
    .addBooleanOption(o => o.setName('clear').setDescription('Clear the cached token (forces fallback to /auth/login on next gen)').setRequired(false))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('autogen')
    .setDescription('Pause or resume auto-generation of tokens after screenshot verification (admin only)')
    .addStringOption(o => o.setName('state').setDescription('Toggle (omit to view current state)').setRequired(false).addChoices(
      { name: 'On — bot auto-generates after screenshot verifies', value: 'on' },
      { name: 'Off — staff must deliver tokens manually', value: 'off' },
    ))
    .addStringOption(o => o.setName('game').setDescription('Limit toggle/status to a single game (omit for global)').setRequired(false).setAutocomplete(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('game')
    .setDescription('Manage a game on the panel (add new, show/hide, set demand tier)')
    .addSubcommand(sub => sub
      .setName('add')
      .setDescription('Add a brand-new game to the catalog (persisted in DB)')
      .addStringOption(o => o.setName('name').setDescription('Game name as it appears on Steam').setRequired(true))
      .addIntegerOption(o => o.setName('appid').setDescription('Steam AppID (numeric)').setRequired(true))
      .addStringOption(o => o.setName('product-uuid').setDescription('Product UUID for token generation (optional)').setRequired(false))
      .addStringOption(o => o.setName('tier').setDescription('Initial tier (default: normal)').setRequired(false).addChoices(
        { name: '🟢 Normal', value: 'normal' },
        { name: '🔥 High Demand', value: 'high' },
        { name: '💎 Donor Only', value: 'donor' },
        { name: '✨ Booster Only', value: 'booster' },
      ))
      .addIntegerOption(o => o.setName('stock').setDescription('Initial stock (default: 5)').setRequired(false)))
    .addSubcommand(sub => sub
      .setName('state')
      .setDescription('Show or hide a game on the panel')
      .addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('state').setDescription('on = visible, off = hidden').setRequired(true).addChoices(
        { name: 'On (visible on panel)', value: 'on' },
        { name: 'Off (hidden from panel)', value: 'off' },
      )))
    .addSubcommand(sub => sub
      .setName('tier')
      .setDescription('Set demand level / access tier for a game')
      .addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('tier').setDescription('Demand/access category').setRequired(true).addChoices(
        { name: '🟢 Normal (24h cooldown, anyone)', value: 'normal' },
        { name: '🔥 High Demand (48h cooldown, anyone)', value: 'high' },
        { name: '💎 Donor Only (2h cooldown, donors only)', value: 'donor' },
        { name: '✨ Booster Only (24h cooldown, boosters + donors)', value: 'booster' },
      )))
    .addSubcommand(sub => sub
      .setName('delete')
      .setDescription('Permanently delete a manually-added game from the DB (cannot delete JSON-synced games)')
      .addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true).setAutocomplete(true)))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('lowstock')
    .setDescription('Set low stock alert threshold')
    .addIntegerOption(o => o.setName('threshold').setDescription('Alert when stock drops to this number'))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('request')
    .setDescription('Vote for a game to be added')
    .addStringOption(o => o.setName('name').setDescription('Game name').setRequired(true)),
  new SlashCommandBuilder()
    .setName('requests')
    .setDescription('View/clear game requests')
    .addBooleanOption(o => o.setName('clear').setDescription('Clear all requests'))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('promo')
    .setDescription('Manage promo codes')
    .addSubcommand(s => s.setName('create').setDescription('Create a promo code')
      .addStringOption(o => o.setName('code').setDescription('The code').setRequired(true))
      .addStringOption(o => o.setName('effect').setDescription('Effect type').setRequired(true)
        .addChoices({ name: 'Cooldown Reset', value: 'cooldown_reset' }, { name: 'Temporary Tier', value: 'temp_tier' }))
      .addStringOption(o => o.setName('tier').setDescription('Tier to grant (for temp_tier)')
        .addChoices({ name: 'Gold', value: 'Gold' }, { name: 'Silver', value: 'Silver' }, { name: 'Bronze', value: 'Bronze' }))
      .addIntegerOption(o => o.setName('duration_hours').setDescription('How long the tier lasts (hours)'))
      .addIntegerOption(o => o.setName('max_uses').setDescription('Max redemptions (default 1)'))
      .addIntegerOption(o => o.setName('expires_in_hours').setDescription('Code expires after this many hours')))
    .addSubcommand(s => s.setName('list').setDescription('List active promo codes'))
    .addSubcommand(s => s.setName('delete').setDescription('Delete a promo code')
      .addStringOption(o => o.setName('code').setDescription('Code to delete').setRequired(true)))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('redeem')
    .setDescription('Redeem a promo code')
    .addStringOption(o => o.setName('code').setDescription('The promo code').setRequired(true)),
  new SlashCommandBuilder()
    .setName('tenant-stats')
    .setDescription('View server token usage stats')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('trust')
    .setDescription('View a user\'s trust score breakdown')
    .addUserOption(o => o.setName('user').setDescription('The user to check').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('waitlist')
    .setDescription('View or leave your game waitlists')
    .addStringOption(o => o.setName('leave').setDescription('Game name to leave the waitlist for').setAutocomplete(true)),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(CONFIG.TOKEN);

async function registerCommands(targetGuildId?: string) {
  try {
    // Clear any global commands (we register per-guild only).
    await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: [] });

    const ownerCmds = OWNER_COMMANDS.map(c => c.toJSON());
    const setlogs = SETLOGS_COMMAND.toJSON();
    const setvouch = SETVOUCH_COMMAND.toJSON();
    const addsupport = ADDSUPPORT_COMMAND.toJSON();

    const tenantCommands = [
      ...commands.filter((c: any) => c.name !== 'test' && c.name !== 'simulate' && c.name !== 'deplet' && c.name !== 'lowstock' && c.name !== 'setsteampass'),
      setlogs,
      setvouch,
      addsupport,
    ];
    const ownerGuildCommands = [...commands, ...ownerCmds, setlogs, setvouch, addsupport];

    const guilds = targetGuildId ? [targetGuildId] : await getAllowedGuildIds();
    for (const gid of guilds) {
      const body = gid === CONFIG.OWNER_GUILD_ID ? ownerGuildCommands : tenantCommands;
      await rest.put(Routes.applicationGuildCommands(CONFIG.CLIENT_ID, gid), { body })
        .catch(e => console.error(`[registerCommands] failed for guild ${gid}:`, e?.message || e));
    }
    console.log(`Successfully reloaded (/) commands for ${guilds.length} guild(s).`);
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`${CONFIG.NAME} is online!`);
  await registerCommands();

  client.user?.setActivity('Denuvo Activations', { type: ActivityType.Watching });

 // ─── SERVER LOCK ENFORCEMENT (multi-tenant) ───
  // Leave only guilds that are neither the home server nor a provisioned
  // tenant. Paused tenants (active=false) are KEPT — they're suspended,
  // not evicted, so /resumeserver can re-enable them later.
  for (const [gid, g] of client.guilds.cache) {
    if (await shouldLeaveGuild(gid)) {
      console.warn(`[ServerLock] Leaving unauthorized guild: ${g.name} (${gid})`);
      await g.leave().catch(err => console.error(`[ServerLock] Failed to leave ${gid}:`, err));
    }
  }

  await syncGamesFromFile();
  initFileWatcher();

  // New: Check for persisted states on startup
  await checkActiveMaintenance();
  await rehydrateVerificationTimers();

  const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
  if (guild) {
    await logAction(guild, '🚀 Bot Online', `**${CONFIG.NAME}** has been successfully initialized and is now active.`, 0x57F287);
  }
});

// ─── GUILD-CREATE GUARD ───
// If the bot is added to any server other than CONFIG.GUILD_ID, leave it
// immediately. Prevents anyone with an invite link from using this bot.
client.on(Events.GuildCreate, async (guild) => {
  if (await shouldLeaveGuild(guild.id)) {
    console.warn(`[ServerLock] Joined unauthorized guild ${guild.name} (${guild.id}) — leaving immediately.`);
    await guild.leave().catch(err => console.error(`[ServerLock] Failed to leave ${guild.id}:`, err));
  } else {
    await registerCommands(guild.id).catch(() => {});
  }
});

/**
 * Handles a vouch timeout — user clicked "Yes, it works!" but didn't vouch in 10 min.
 * Marks the ticket as a strike (screenshotVerified=false), applies 48h cooldown,
 * and escalates to a permanent ban if the user has now hit 3 strikes total.
 */
async function applyVouchTimeoutStrike(ticketId: number, userId: string, channelId: string) {
  const until = new Date(Date.now() + 48 * 60 * 60 * 1000);
  await prisma.cooldown.upsert({
    where: { userId },
    update: { until },
    create: { userId, until }
  });

  // Revoke verification flag so this counts in the strike query
  await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      status: 'CLOSED',
      closedAt: new Date(),
      screenshotVerified: false,
      vouchExpiresAt: null
    }
  });

  // Count strikes (CLOSED tickets with screenshotVerified=false)
  const failures = await prisma.ticket.count({
    where: { userId, status: 'CLOSED', screenshotVerified: false }
  });

  let permanentBan = false;
  if (failures >= 3) {
    const permanent = new Date();
    permanent.setFullYear(permanent.getFullYear() + 99);
    await prisma.cooldown.upsert({
      where: { userId },
      update: { until: permanent },
      create: { userId, until: permanent }
    });
    permanentBan = true;
  }

  const ch = await client.channels.fetch(channelId).catch(() => null) as TextChannel | null;
  if (ch) {
    const msg = permanentBan
      ? `🚫 **Permanent Cooldown:** Vouch requirement not met. **3/3 strikes** reached.`
      : `🚨 **Session Terminated:** Vouch requirement not met. 48h cooldown applied. **Strike: ${failures}/3**`;
    await ch.send({ content: msg }).catch(() => {});
    setTimeout(() => ch.delete().catch(() => {}), 5000);
  }

  const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
  if (guild) {
    const title = permanentBan ? '🚫 Vouch Timeout (Permanent Ban)' : '🚨 Vouch Timeout (Strike)';
    await logAction(
      guild,
      title,
      `User <@${userId}> failed to vouch in time.\n**Strikes:** \`${failures}/3\`${permanentBan ? '\n**Status:** Permanent cooldown applied.' : ''}`,
      0xED4245
    );
  }
  if (ch && ch.guildId) {
    const title = permanentBan ? '🚫 Vouch Timeout (Permanent Ban)' : '🚨 Vouch Timeout (Strike)';
    await logTenant(
      ch.guildId,
      title,
      `User <@${userId}> failed to vouch in time.\n**Strikes:** \`${failures}/3\`${permanentBan ? '\n**Status:** Permanent cooldown applied.' : ''}`,
      0xED4245
    );
  }

  vouchTimers.delete(userId);
  await refreshAllPanels();
}
async function rehydrateVerificationTimers() {
  console.log('[Boot] Rehydrating session timers...');
  const openTickets = await prisma.ticket.findMany({
    where: { 
      OR: [
        { status: 'OPEN', screenshotVerified: false },
        { status: { in: ['OPEN', 'CLAIMED'] }, vouchExpiresAt: { not: null } }
      ]
    },
    include: { game: true }
  });

  for (const ticket of openTickets) {
    if ((ticket.status === 'OPEN' || ticket.status === 'CLAIMED') && !ticket.screenshotVerified) {
      const elapsedMs = Date.now() - ticket.createdAt.getTime();
      const remainingMs = Math.max(0, (10 * 60 * 1000) - elapsedMs);
      
      const timer = setTimeout(async () => {
        const channel = await client.channels.fetch(ticket.channelId).catch(() => null);
        if (channel && !channel.partial && 'guild' in channel) {
          await autoCloseTicketForVerificationTimeout(ticket.channelId, channel.guild as Guild);
        }
      }, remainingMs);

      pendingVerificationTimers.set(ticket.channelId, timer);
    }

    if (ticket.vouchExpiresAt) {
      const elapsedMs = Date.now() - (ticket.vouchExpiresAt.getTime() - (10 * 60 * 1000));
      const remainingMs = Math.max(0, ticket.vouchExpiresAt.getTime() - Date.now());

      const timeout = setTimeout(async () => {
        const currentTicket = await prisma.ticket.findUnique({ where: { id: ticket.id } });
        if (currentTicket && currentTicket.status !== 'CLOSED') {
          await applyVouchTimeoutStrike(currentTicket.id, currentTicket.userId, currentTicket.channelId);
        }
      }, remainingMs);

      vouchTimers.set(ticket.userId, timeout);
    }
  }
  console.log(`[Boot] Restored ${openTickets.length} session timers.`);
}

client.on('interactionCreate', async (interaction) => {
  try {
    // ─── SIMULATE: handle at the top to bypass all other middleware ───
    if (interaction.isChatInputCommand() && interaction.commandName === 'simulate') {
      console.log('[Simulate] === INTERCEPTED at top of interactionCreate ===');
      if (interaction.guildId !== CONFIG.OWNER_GUILD_ID) {
        return interaction.reply({ content: '❌ This command is not available in this server.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
      }

      // During rolling deploys Railway runs two instances briefly. The other
      // instance may deferReply before us (error 40060). If so, continue —
      // editReply works from either instance since both share the bot token.
      try {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        console.log('[Simulate] deferReply succeeded');
      } catch (deferErr: any) {
        if (deferErr?.code === 40060) {
          console.log('[Simulate] Already acknowledged by another instance — continuing with editReply');
        } else {
          console.error('[Simulate] deferReply failed:', deferErr);
          return;
        }
      }

      try {
        const gameName = interaction.options.getString('game');
        if (!gameName) {
          return interaction.editReply({ content: '❌ No game specified.' });
        }
        const game = await prisma.game.findUnique({ where: { name: gameName } });
        if (!game) {
          return interaction.editReply({ content: `❌ **Not Found:** Game **${gameName}** does not exist.` });
        }
        const guild = interaction.guild;
        if (!guild) {
          return interaction.editReply({ content: '❌ Must be used in a server.' });
        }

        const botMember = guild.members.me;
        if (!botMember || !botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
          return interaction.editReply({ content: '❌ Bot needs **Manage Channels** permission to create a simulation channel.' });
        }

        await interaction.editReply({ content: '🎬 Setting up simulation channel...' });

        const channelName = `sim-${game.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
        console.log('[Simulate] Creating channel:', channelName);
        const permOverwrites: any[] = [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ];
        if (client.user) {
          permOverwrites.push({ id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] });
        }
        const channel = await guild.channels.create({ name: channelName, permissionOverwrites: permOverwrites });
        console.log('[Simulate] Channel created:', channel.id);
        await interaction.editReply({ content: `🎬 Simulation started in <#${channel.id}> — watch it play out!` });
        runSimulation(channel, game, interaction.user, interaction.member as GuildMember, guild).catch(e => {
          console.error('[Simulate] runSimulation error:', e);
          channel.send({ content: `❌ Simulation error: ${(e as Error).message}` }).catch(() => {});
        });
      } catch (e) {
        console.error('[Simulate] Error:', e);
        await interaction.editReply({ content: `❌ Simulation failed: ${(e as Error).message}` }).catch(() => {});
      }
      return;
    }

    // ─── DEPLET: handle at the top to bypass all other middleware ───
    if (interaction.isChatInputCommand() && interaction.commandName === 'deplet') {
      console.log('[Deplet] === INTERCEPTED at top of interactionCreate ===');
      if (interaction.guildId !== CONFIG.OWNER_GUILD_ID) {
        return interaction.reply({ content: '❌ This command is not available in this server.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
      }

      try {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        console.log('[Deplet] deferReply succeeded');
      } catch (deferErr: any) {
        if (deferErr?.code === 40060) {
          console.log('[Deplet] Already acknowledged by another instance — continuing with editReply');
        } else {
          console.error('[Deplet] deferReply failed:', deferErr);
          return;
        }
      }

      try {
        const sub = interaction.options.getSubcommand();
        if (sub === 'all') {
          const depletedAt = new Date();
          const [gamesResult, restocksResult] = await prisma.$transaction([
            prisma.game.updateMany({ data: { stock: 0, lastDepletedAt: depletedAt } }),
            prisma.restock.deleteMany({}),
          ]);
          await refreshAllPanels();
          await interaction.editReply({
            content: `✅ **All tokens depleted:** Set \`${gamesResult.count}\` game(s) to \`0\` token(s). Cleared \`${restocksResult.count}\` pending restock(s).`,
          });
          logAction(interaction.guild!, '🗑️ Deplet All', `**${interaction.user.tag}** depleted all games (${gamesResult.count}) and cleared ${restocksResult.count} restocks`, 0xFF0000);
        } else if (sub === 'game') {
          const gameName = interaction.options.getString('game', true);
          const game = await prisma.game.findUnique({ where: { name: gameName } });
          if (!game) {
            await interaction.editReply({ content: `❌ **Not Found:** Game **${gameName}** does not exist.` });
          } else {
            await prisma.game.update({ where: { id: game.id }, data: { stock: 0, lastDepletedAt: new Date() } });
            await prisma.restock.deleteMany({ where: { gameId: game.id } });
            await refreshAllPanels();
            await interaction.editReply({
              content: `✅ **${game.name}** depleted: set to \`0\` tokens.`,
            });
            logAction(interaction.guild!, '🗑️ Deplet Game', `**${interaction.user.tag}** depleted **${game.name}**`, 0xFF0000);
          }
        }
      } catch (e) {
        console.error('[Deplet] Error:', e);
        await interaction.editReply({ content: `❌ Deplet failed: ${(e as Error).message}` }).catch(() => {});
      }
      return;
    }

    // ─── GLOBAL SERVER LOCK ───
    // Bot only operates in CONFIG.GUILD_ID. Reject all interactions from
    // any other guild. Autocomplete is silently ignored (no reply API);
    // others get a polite ephemeral rejection.
if (interaction.guildId) {
      const verdict = await checkGuild(interaction.guildId);
      if (!verdict.allowed) {
        const msg = verdict.reason === 'paused'
          ? '⏸️ This server is currently suspended. Please contact the bot owner.'
          : '❌ This server is not authorized to use this bot.';
        if (interaction.isAutocomplete()) {
          await interaction.respond([]).catch(() => {});
        } else if (interaction.isRepliable()) {
          await interaction.reply({ content: msg, flags: [MessageFlags.Ephemeral] }).catch(() => {});
        }
        return;
      }
    }

    // Owner-only + /setlogs commands are handled in their own module.
    if (interaction.isChatInputCommand()) {
      const handled = await handleTenantCommand(interaction);
      if (handled) return;
    }

    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      await handleChatCommand(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      await handleSelectMenu(interaction);
      return;
    }

    if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
      return;
    }
  } catch (error) {
    const err = error as Error;
    console.error('Interaction Error:', err);
    if (interaction.isRepliable()) {
      const payload = { content: `❌ **Something went wrong.** Please try again or contact staff.` };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply({ ...payload, flags: [MessageFlags.Ephemeral] }).catch(() => {});
      }
    }
  }
});

async function handleAutocomplete(interaction: any) {
  if (interaction.commandName === 'stock' || interaction.commandName === 'exclude-auto' || interaction.commandName === 'test' || interaction.commandName === 'tokengen' || interaction.commandName === 'setmode' || interaction.commandName === 'getmode' || interaction.commandName === 'game' || interaction.commandName === 'removegame' || interaction.commandName === 'settokens' || interaction.commandName === 'autogen' || interaction.commandName === 'simulate' || interaction.commandName === 'deplet' || interaction.commandName === 'waitlist') {
    const focusedValue = interaction.options.getFocused();
    const games = await prisma.game.findMany({
      where: { name: { contains: focusedValue, mode: 'insensitive' } },
      take: 24, // leave room for the synthetic "ALL" entry on bulk-capable commands
    });

    const entries = games.map((g: { name: string }) => ({ name: g.name, value: g.name }));

    // /setmode and /getmode accept "ALL" to act on every game. Surface it as
    // the first autocomplete suggestion when the input is empty or matches "a".
    const bulkCapable = interaction.commandName === 'setmode' || interaction.commandName === 'getmode';
    if (bulkCapable) {
      const f = focusedValue.toLowerCase();
      if (f === '' || 'all'.startsWith(f)) {
        entries.unshift({ name: 'ALL — apply to every game', value: 'ALL' });
      }
    }

    await interaction.respond(entries.slice(0, 25));
  }
}

async function handleChatCommand(interaction: any) {
  if (interaction.commandName === 'test' && interaction.guildId !== CONFIG.OWNER_GUILD_ID) {
    return interaction.reply({
      content: '❌ This command is not available in this server.',
      flags: [MessageFlags.Ephemeral],
    }).catch(() => {});
  }

  const USER_FACING_COMMANDS = new Set(['mycooldown', 'profile', 'onduty', 'request', 'redeem', 'waitlist']);
  if (!USER_FACING_COMMANDS.has(interaction.commandName)) {
    const m = interaction.member as GuildMember | null;
    const hasAdmin = m?.permissions?.has?.(PermissionsBitField.Flags.Administrator);
    if (!hasAdmin) {
      return interaction.reply({
        content: '❌ **Unauthorized:** This command requires Administrator permission.',
        flags: [MessageFlags.Ephemeral],
      }).catch(() => {});
    }
  }

  const isPublic = interaction.commandName === 'staffstats' || interaction.commandName === 'tokengen';
  try {
    await interaction.deferReply({ flags: isPublic ? [] : [MessageFlags.Ephemeral] });
  } catch (deferErr: any) {
    if (deferErr?.code === 40060) {
      console.log(`[${interaction.commandName}] Already acknowledged by another instance — continuing`);
    } else {
      console.error(`[${interaction.commandName}] deferReply failed:`, deferErr);
      return;
    }
  }

  const handler = commandHandlers[interaction.commandName];
  if (handler) {
    await handler(interaction);
  } else {
    await interaction.editReply({ content: '❌ Unknown command.' }).catch(() => {});
  }
}

async function runSimulation(channel: any, game: any, user: any, member: GuildMember, guild: Guild) {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const { getTierForGuild } = await import('./utils/permissions');
  const { resolveServerConfig } = await import('./utils/tenant');
  const sc = await resolveServerConfig(guild.id);
  const userTier = await getTierForGuild(member, guild.id);

  // Step 1: Header
  const headerEmbed = new EmbedBuilder()
    .setTitle('🎬 Simulation Mode')
    .setDescription(`Previewing the full user experience for **${game.name}**.\nEach step will appear with a short delay.\n\n*No tokens, tickets, or cooldowns are affected.*`)
    .setColor(0xFEE75C)
    .setTimestamp();
  await channel.send({ embeds: [headerEmbed] });
  await sleep(2000);

  // Step 2: Ticket control message (what staff sees)
  const waitTime = await getEstimatedWaitTime();
  const controlEmbed = new EmbedBuilder()
    .setTitle(`🎫 ${CONFIG.NAME} • Denuvo Check`)
    .setDescription(`Denuvo check initialized for ${user}.\n\n━━━━━━━━━━━━━━━━━━━━━━\n*(info.md content would appear here)*\n━━━━━━━━━━━━━━━━━━━━━━`)
    .addFields(
      { name: '👤 Requester', value: `${user}`, inline: true },
      { name: '💎 Membership', value: `\`${userTier}\``, inline: true },
      { name: '🎮 Game', value: `\`${game.name}\``, inline: true },
      { name: '🆔 App ID', value: `\`${game.appId || 'N/A'}\``, inline: true },
      { name: '🕒 Activity Meta', value: `\`${waitTime}\` (ETA: Now)`, inline: true },
      { name: '🛰️ Session Status', value: '🟢 **Awaiting Check**', inline: true }
    )
    .setColor(0x5865F2)
    .setTimestamp()
    .setFooter({ text: `${CONFIG.NAME} • Secure Session ID: SIM-0000` });

  const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sim_claim').setLabel('Claim Ticket').setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId('sim_unclaim').setLabel('Unclaim').setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId('sim_close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setDisabled(true)
  );
  await channel.send({ embeds: [controlEmbed], components: [controlRow] });
  await sleep(3000);

  // Step 3: Verification prompt
  const verifyEmbed = createVerificationPromptEmbed(user);
  await channel.send({ embeds: [verifyEmbed] });
  await sleep(3000);

  // Step 4: User "uploads screenshot" (simulated)
  const uploadNotice = new EmbedBuilder()
    .setTitle('📸 [Simulated] User uploads screenshot')
    .setDescription('*In a real session, the user would upload a screenshot here showing their game directory, Windows Update Blocker, and file properties.*')
    .setColor(0x2B2D31);
  await channel.send({ embeds: [uploadNotice] });
  await sleep(2000);

  // Step 5: Verification processing
  const processingEmbed = createVerificationProcessingEmbed();
  await channel.send({ embeds: [processingEmbed] });
  await sleep(3000);

  // Step 6: Verification success
  const successEmbed = createVerificationSuccessEmbed();
  await channel.send({ embeds: [successEmbed] });
  await sleep(3000);

  // Step 7: Token generation message
  const genEmbed = new EmbedBuilder()
    .setTitle(`⚙️ ${CONFIG.NAME} • Generating Token...`)
    .setDescription(`Generating activation token for **${game.name}** (AppID: \`${game.appId}\`).\n\nPlease wait, this may take up to 30 seconds.`)
    .setColor(0x5865F2)
    .setTimestamp();
  await channel.send({ embeds: [genEmbed] });
  await sleep(3000);

  // Step 8: Token delivery
  const deliveryEmbed = createTokenDeliveryEmbed(
    game.name,
    user.id,
    client.user!,
    { url: '#', expiryText: '30 minutes (simulated)', sizeMB: '~9.0' },
  );
  const worksRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sim_works_yes').setLabel('Confirm Working').setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId('sim_works_no').setLabel('Report Issue').setStyle(ButtonStyle.Danger).setDisabled(true)
  );
  await channel.send({ embeds: [deliveryEmbed], components: [worksRow] });
  await sleep(3000);

  // Step 9: User clicks "Confirm Working" (simulated)
  const clickNotice = new EmbedBuilder()
    .setTitle('✅ [Simulated] User clicks "Confirm Working"')
    .setDescription('*In a real session, the user would click the green button after verifying the game works.*')
    .setColor(0x2B2D31);
  await channel.send({ embeds: [clickNotice] });
  await sleep(2000);

  // Step 10: Vouch request
  const vouchEmbed = createVouchRequestEmbed(
    sc.voucherChannelId || '(not configured)',
    user.id,
    client.user!.id,
  );
  await channel.send({ embeds: [vouchEmbed] });
  await sleep(3000);

  // Step 11: Vouch verified
  const g = game as any;
  const cooldownHours = g.donatorOnly ? 2 : g.highDemand ? 48 : 24;
  const closeEmbed = new EmbedBuilder()
    .setTitle('✅ Vouch Auto-Verified')
    .setDescription(`Vouch + screenshot detected. Session closed.\n\n**Cooldown:** \`${cooldownHours}h\`\n**Token Deducted:** \`YES\``)
    .setColor(0x57F287)
    .setTimestamp();
  await channel.send({ embeds: [closeEmbed] });
  await sleep(3000);

  // Step 12: Summary
  const summaryEmbed = new EmbedBuilder()
    .setTitle('🎬 Simulation Complete')
    .setDescription(
      `All steps of the user flow for **${game.name}** have been shown.\n\n` +
      `**Flow summary:**\n` +
      `1. Ticket opens → verification prompt (10m timer)\n` +
      `2. User uploads screenshot → AI verifies (3 retries)\n` +
      `3. Token auto-generated → uploaded to file host\n` +
      `4. User confirms working → vouch request (10m timer)\n` +
      `5. User vouches → cooldown applied (\`${cooldownHours}h\`), channel deleted\n\n` +
      `*This channel will self-destruct in 15 seconds.*`
    )
    .setColor(0x57F287)
    .setTimestamp();
  await channel.send({ embeds: [summaryEmbed] });

  setTimeout(() => channel.delete().catch(() => {}), 15000);
}

async function handleSelectMenu(interaction: any) {
  if (interaction.customId.startsWith('select_game_')) {
    await createTicket(interaction, interaction.values[0]);
  } else if (interaction.customId.startsWith('close_cooldown_select_')) {
    await handleCooldownSelection(interaction);
  }
}

async function handleButtonInteraction(interaction: any) {
  if (interaction.customId === 'claim_ticket') await claimTicket(interaction);
  else if (interaction.customId === 'unclaim_ticket') await unclaimTicket(interaction);
  else if (interaction.customId === 'close_ticket') await closeTicket(interaction);
  else if (interaction.customId.startsWith('close_deduct_')) {
    const choice = interaction.customId.split('_').pop() as 'yes' | 'no';
    await handleDeductionChoice(interaction, choice);
  } else if (interaction.customId.startsWith('notify_me_')) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const gameId = parseInt(interaction.customId.split('_').pop()!);
    const result = await addSubscription(interaction.user.id, gameId);
    await interaction.editReply({ content: result.message });
  } else if (interaction.customId === 'works_yes') {
    await handleWorksYes(interaction);
  } else if (interaction.customId === 'works_no') {
    await handleWorksNo(interaction);
  }
}

async function handleWorksYes(interaction: any) {
  await interaction.deferUpdate();
  const ticket = await prisma.ticket.findFirst({ where: { channelId: interaction.channelId } });
  if (ticket && (interaction.user.id === ticket.userId)) {
    const wySc = await (await import('./utils/tenant')).resolveServerConfig(interaction.guildId);
    const vouchEmbed = createVouchRequestEmbed(wySc.voucherChannelId, ticket.staffId!, client.user!.id);
    if (interaction.channel && 'send' in interaction.channel) {
      const vouchReply = await (interaction.channel as TextChannel).send({ embeds: [vouchEmbed] });
      await vouchReply.react('❤️').catch(() => {});
    }

    const vouchExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await prisma.ticket.update({
      where: { channelId: interaction.channelId },
      data: { vouchExpiresAt, vouchStaffId: ticket.staffId }
    });

    const timeout = setTimeout(async () => {
      const current = await prisma.ticket.findFirst({ where: { channelId: interaction.channelId } });
      if (current && current.status !== 'CLOSED' && current.vouchExpiresAt) {
        await applyVouchTimeoutStrike(current.id, current.userId, interaction.channelId);
      } else {
        vouchTimers.delete(interaction.user.id);
      }
    }, 10 * 60 * 1000);

    vouchTimers.set(interaction.user.id, timeout);
  } else {
    await interaction.followUp({ content: '❌ **Unauthorized.**', flags: [MessageFlags.Ephemeral] });
  }
}

async function handleWorksNo(interaction: any) {
  await interaction.deferUpdate();
  const ticket = await prisma.ticket.findFirst({ where: { channelId: interaction.channelId } });
  if (ticket && interaction.user.id === ticket.userId) {
    const wnSc = await (await import('./utils/tenant')).resolveServerConfig(interaction.guildId);
    const failureHelpEmbed = new EmbedBuilder()
      .setTitle('⚠️ Issue Reported')
      .setDescription(`System alerted activators (<@&${wnSc.activatorsRoleId}>). Please wait.`)
      .setColor(0xED4245)
      .setTimestamp();

    if (interaction.channel && 'send' in interaction.channel) {
      await (interaction.channel as TextChannel).send({ embeds: [failureHelpEmbed] });
      await (interaction.channel as TextChannel).send({ content: `<@&${wnSc.activatorsRoleId}>, user <@${interaction.user.id}> reported issues.` });
    }

    const guild = interaction.guild;
    if (guild) await logAction(guild, '⚠️ Activation Issue', `User <@${interaction.user.id}> reported issues for **${ticket.gameId}**.`, 0xED4245);

  } else {
    await interaction.followUp({ content: '❌ **Unauthorized.**', flags: [MessageFlags.Ephemeral] });
  }
}
 
 client.on(Events.GuildMemberRemove, async (member) => {
   try {
     const openTickets = await prisma.ticket.findMany({
       where: {
         userId: member.id,
         status: { in: ['OPEN', 'CLAIMED'] }
       }
     });
 
     if (openTickets.length > 0) {
       for (const ticket of openTickets) {
         try {
           await prisma.ticket.update({
             where: { id: ticket.id },
             data: { status: 'CLOSED', closedAt: new Date() }
           });

           const timer = pendingVerificationTimers.get(ticket.channelId);
           if (timer) {
             clearTimeout(timer);
             pendingVerificationTimers.delete(ticket.channelId);
           }

           const vTimer = vouchTimers.get(ticket.userId);
           if (vTimer) {
             clearTimeout(vTimer);
             vouchTimers.delete(ticket.userId);
           }

           const channel = (await client.channels.fetch(ticket.channelId).catch(() => null)) as TextChannel;
           if (channel) {
             await channel.send({ content: `🔒 **Denuvo Check:** Requester has left the server. Session terminated. Closing in 5s.` }).catch(() => {});
             setTimeout(() => channel.delete().catch(() => {}), 10000);
           }
         } catch (err) {
           console.error(`Error closing ticket ${ticket.id} on member leave:`, err);
         }
       }
       await refreshAllPanels();
     }
   } catch (error) {
     console.error('Error in GuildMemberRemove event:', error);
   }
 });



client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const ticket = await prisma.ticket.findUnique({
    where: { channelId: message.channelId },
    include: { verification: true, game: true }
  });

  if (ticket && message.author.id === ticket.userId) {
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { lastUserActivityAt: new Date() }
    });
  }

  if (ticket && ticket.verification && message.author.id === ticket.userId) {
    if (ticket.verification.isProcessing) return;

    const attachment = message.attachments.first();
    if (attachment && attachment.contentType?.startsWith('image/')) {
      // Clear the 10-minute timer immediately so it doesn't fire while we are processing
      const tTimer = pendingVerificationTimers.get(message.channelId);
      if (tTimer) {
        clearTimeout(tTimer);
        console.log(`[Verification] Timer cleared for processing in ${message.channelId}`);
      }
      
      await prisma.pendingVerification.update({
        where: { ticketId: ticket.id },
        data: { isProcessing: true }
      });

      const processingEmbed = createVerificationProcessingEmbed();
      const waitMessage = await message.reply({ embeds: [processingEmbed] });

      const { isValid, reasoning } = await verifyScreenshot(attachment.url, ticket.game.name);

      if (isValid) {
        await prisma.pendingVerification.delete({
          where: { ticketId: ticket.id }
        });
        
        await prisma.ticket.update({
          where: { channelId: message.channelId },
          data: { screenshotVerified: true }
        });

        const successEmbed = createVerificationSuccessEmbed();
        await waitMessage.edit({ embeds: [successEmbed] });

        const homeGuild = client.guilds.cache.get(CONFIG.GUILD_ID);
        const guild = message.guild;
        if (homeGuild) {
          await logAction(homeGuild, '✅ Screenshot Verified', `User ${message.author} has posted a valid screenshot for **${ticket.game.name}** in <#${message.channelId}>.`, 0x57F287);
        }
        if (message.guildId) {
          await logTenant(message.guildId, '✅ Screenshot Verified', `User ${message.author} has posted a valid screenshot for **${ticket.game.name}** in <#${message.channelId}>.`, 0x57F287);
        }

        // Per-server support-role mention — '' for a buyer that hasn't run
        // /addsupport, so we ping nothing instead of a broken role mention.
        const msgSc = await (await import('./utils/tenant')).resolveServerConfig(message.guildId ?? '');
        const staffPing = msgSc.staffPing;

        // ─── SECURITY: don't auto-gen off an UNVERIFIED screenshot ───
        // If GROQ_API_KEY isn't set, verifyScreenshot() returned the sentinel
        // reason and isValid=true so the user sees a friendly state, but we
        // MUST NOT auto-generate against an unverified image. Route to staff.
        if (reasoning === VERIFY_BYPASS_REASON) {
          const bypassEmbed = new EmbedBuilder()
            .setTitle('⚠️ Verification Disabled')
            .setDescription(`Your screenshot has been received for **${ticket.game.name}**.\n\nAutomatic AI verification is currently unavailable. A staff member will review it manually and deliver your token shortly.`)
            .setColor(0xFEE75C)
            .setTimestamp();
          await (message.channel as TextChannel).send({ embeds: [bypassEmbed] });
          await (message.channel as TextChannel).send({ content: `${staffPing} **GROQ_API_KEY not configured.** Screenshot received for **${ticket.game.name}** (AppID \`${ticket.game.appId}\`). Please review and deliver manually with \`/tokengen\`.` });
          if (homeGuild) {
            await logAction(homeGuild, '⚠️ AI Verify Bypassed', `Screenshot for **${ticket.game.name}** in <#${message.channelId}> wasn't verified by AI (GROQ_API_KEY missing). Manual staff review required.`, 0xFEE75C);
          }
          return;
        }

        // ─── AUTO-GENERATE TOKEN (skipped if /autogen is paused) ───
        // Two independent gates:
        //   - Global: Metadata key "autoGenEnabled". Pauses every game.
        //   - Per-game: Game.autoGenDisabled. Pauses just this game.
        // Either being "off" routes the ticket to manual staff delivery.
        const autoGenSetting = await prisma.metadata.findUnique({ where: { key: 'autoGenEnabled' } });
        const globallyEnabled = autoGenSetting?.value !== 'false';
        const gamePaused = (ticket.game as any).autoGenDisabled === true;
        const autoGenEnabled = globallyEnabled && !gamePaused;

        if (!autoGenEnabled) {
          const scope = !globallyEnabled ? 'globally' : `for **${ticket.game.name}**`;
          const pausedEmbed = new EmbedBuilder()
            .setTitle('⏸️ Auto-Generation Paused')
            .setDescription(`Screenshot verified successfully for **${ticket.game.name}**.\n\nAuto-generation is currently paused ${scope}. A team member will deliver your token manually.`)
            .setColor(0xFEE75C)
            .setTimestamp();
          await (message.channel as TextChannel).send({ embeds: [pausedEmbed] });
          await (message.channel as TextChannel).send({ content: `${staffPing} Auto-gen is paused ${scope} — manual delivery needed for **${ticket.game.name}** (AppID \`${ticket.game.appId}\`).` });
          if (homeGuild) {
            const logTitle = !globallyEnabled
              ? '⏸️ Auto-Gen Skipped (Global Pause)'
              : '⏸️ Auto-Gen Skipped (Per-Game Pause)';
            await logAction(homeGuild, logTitle, `Screenshot verified for **${ticket.game.name}** in <#${message.channelId}>. Auto-gen paused ${scope} — staff needs to deliver manually.`, 0xFEE75C);
          }
          return; // Skip the rest of the auto-gen block
        }

        const genEmbed = new EmbedBuilder()
          .setTitle('⚙️ Generating Token...')
          .setDescription(`Denuvo token is being generated for **${ticket.game.name}** (AppID: \`${ticket.game.appId}\`).\nPlease wait, this may take up to 30 seconds.`)
          .setColor(0x5865F2)
          .setTimestamp();
        const genMsg = await (message.channel as TextChannel).send({ embeds: [genEmbed] });

        try {
          const appId = ticket.game.appId;
          if (!appId) throw new Error('Game has no AppID configured.');

          // Owner server: pick a pool account with daily quota left for this
          // game; if all are used up, tell the user (generic — no mechanism).
          // Buyer server: pass guildId so its OWN account is used.
          let poolAccountId: number | null = null;
          let accountOverride: { login: string; password: string } | undefined;
          if (message.guildId === CONFIG.OWNER_GUILD_ID) {
            const picked = await pickOwnerAccount(appId);
            if (picked.exhausted) {
              const outEmbed = new EmbedBuilder()
                .setTitle('🔴 Out of Tokens Today')
                .setDescription(`**${ticket.game.name}** is **out of tokens for today.** Fresh tokens unlock at 00:00 UTC — please try again tomorrow.`)
                .setColor(0xED4245)
                .setTimestamp();
              await genMsg.edit({ embeds: [outEmbed] });
              return;
            }
            if (picked.account) {
              poolAccountId = picked.account.id;
              accountOverride = { login: picked.account.login, password: picked.account.password };
            }
          }

          const { zipPath, logs, installerKey, ticketHash, expectedHmac, appIdBound } = await generateToken(appId, ticket.game.name, message.guildId ?? undefined, accountOverride);
          console.log(`[TokenGen] Logs for ${ticket.game.name}:\n${logs}`);
          if (poolAccountId) await recordOwnerUsage(poolAccountId, appId);

          if (zipPath) {
            const safeGameName = ticket.game.name.replace(/[<>:"/\\|?*]/g, '').trim();

            // Pre-flight: check zip size against Discord's upload limit before attempting.
            // Default tier = 10 MiB, boost level 2 = 50 MiB, boost level 3 = 100 MiB.
            // discord.js v14: `guild.premiumTier` gives 0/1/2/3.
            const fsMod = await import('fs');
            const zipBytes = fsMod.statSync(zipPath).size;
            const tier = guild?.premiumTier ?? 0;
            const limitMB = tier >= 3 ? 100 : tier >= 2 ? 50 : 10;
            const zipMB = zipBytes / (1024 * 1024);

            // Always route through self-hosted upload for 30-min link.
              console.log(`[TokenGen] Routing zip ${zipMB.toFixed(1)} MB through uploadFile for 30-min self-hosted link`);

              const uploadingEmbed = new EmbedBuilder()
                .setTitle('📤 Uploading Token')
                .setDescription(
                  `Preparing your **${zipMB.toFixed(1)} MB** token zip.\n\n` +
                  `Uploading to our secure host so you can download it directly. This takes up to a minute for large files.`
                )
                .setColor(0xFEE75C)
                .setTimestamp();
              await genMsg.edit({ embeds: [uploadingEmbed] });

              let upload: Awaited<ReturnType<typeof uploadFile>> | null = null;
              try {
                upload = await uploadFile(zipPath, '72h', installerKey, { ticketHash, expectedHmac, appIdBound });
                console.log(`[TokenGen] Uploaded via ${upload.provider}: ${upload.url}`);
              } catch (uploadErr) {
                const ue = uploadErr as Error;
                console.error('[TokenGen] Litterbox upload failed:', ue);
                const failEmbed = new EmbedBuilder()
                  .setTitle('⚠️ Upload Failed')
                  .setDescription(
                    `Token zip (${zipMB.toFixed(1)} MB) upload to file host failed.\n\n` +
                    `\`\`\`\n${(ue?.message || String(ue)).slice(0, 300)}\n\`\`\`\n` +
                    `Staff has been notified for manual delivery.`
                  )
                  .setColor(0xED4245)
                  .setTimestamp();
                await genMsg.edit({ embeds: [failEmbed] });
                await (message.channel as TextChannel).send({ content: `${staffPing} Auto-gen worked but the zip is ${zipMB.toFixed(1)} MB and won't fit Discord (${limitMB} MB). External upload also failed. Manual delivery needed.` });
                if (homeGuild) {
                  await logAction(homeGuild, '⚠️ Token Upload Failed', `**${ticket.game.name}** — zip ${zipMB.toFixed(1)} MB > Discord limit ${limitMB} MB. Litterbox upload error:\n\`\`\`\n${(ue?.message || String(ue)).slice(0, 500)}\n\`\`\``, 0xED4245);
                }
                try { fsMod.unlinkSync(zipPath); } catch {}
                return;
              }

              // Success: post the link using the unified delivery embed
              const linkEmbed = createTokenDeliveryEmbed(
                ticket.game.name,
                ticket.userId,
                client.user!,
                { url: upload.url, expiryText: upload.expiryText, sizeMB: zipMB.toFixed(1) },
              );

              const worksRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('works_yes').setLabel('Confirm Working').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('works_no').setLabel('Report Issue').setStyle(ButtonStyle.Danger)
              );

              const deliveryMsg = await (message.channel as TextChannel).send({
                embeds: [linkEmbed],
                components: [worksRow]
              });

              await prisma.ticket.update({
                where: { id: ticket.id },
                data: { deliveryMessageId: deliveryMsg.id, staffId: client.user!.id }
              });

              await genMsg.delete().catch(() => {});
              await deliveryMsg.react('❤️').catch(() => {});

              if (homeGuild) {
                await logAction(homeGuild, '🤖 Auto-Token Delivered (External Host)', `Bot auto-generated and delivered token for **${ticket.game.name}** (${zipMB.toFixed(1)} MB) via ${upload.provider} in <#${message.channelId}>. Link: ${upload.url}`, 0x57F287);
              }
              // Basic sanitized log for a buyer server (no-op on home server).
              if (message.guildId) {
                await logTenant(message.guildId, '📦 Token Delivered', `A token for **${ticket.game.name}** was delivered to <@${ticket.userId}>.`, 0x57F287);
              }

              // Clean up local zip — we have the hosted copy
              try { fsMod.unlinkSync(zipPath); } catch {}

          } else {
            const failEmbed = new EmbedBuilder()
              .setTitle('⚠️ Auto-Generation Failed')
              .setDescription(`Could not auto-generate token for **${ticket.game.name}**.\nA staff member will need to handle this manually.`)
              .setColor(0xED4245)
              .setTimestamp();
            await genMsg.edit({ embeds: [failEmbed] });

            await (message.channel as TextChannel).send({ content: `${staffPing} Auto-generation failed. Manual token delivery needed.` });

            try {
              const homeGuild = client.guilds.cache.get(CONFIG.GUILD_ID);
              if (homeGuild) {
                await logAction(homeGuild, '⚠️ Auto-Gen Failed', `Auto-generation failed for **${ticket.game.name}** (AppID \`${(ticket.game as any).appId}\`).\n\n\`\`\`\n${logs.slice(-500)}\n\`\`\``, 0xED4245);
              }
            } catch {}
          }
        } catch (genError) {
          const ge = genError as Error;
          console.error('[TokenGen] Error:', ge);

          const detail = ge?.message || String(ge);
          let hint = '';
          if (detail.includes('Request entity too large') || detail.includes('Payload Too Large') || detail.includes('25 MB') || detail.includes('413')) {
            hint = '\n\n*The zip exceeds this server\'s Discord upload limit. Server needs to be boosted, or the template needs to be slimmed down.*';
          } else if (detail.includes('ENOENT') || detail.includes('no such file')) {
            hint = '\n\n*The Python script reported success but the zip path it returned doesn\'t exist on disk.*';
          } else if (detail.includes('timed out') || detail.includes('timeout')) {
            hint = '\n\n*Python script ran past the 120-second timeout.*';
          }

          const errEmbed = new EmbedBuilder()
            .setTitle('⚠️ Generation Error')
            .setDescription(`Token generation encountered an error for **${ticket.game.name}**.\nA staff member has been notified and will handle this manually.`)
            .setColor(0xED4245);
          await genMsg.edit({ embeds: [errEmbed] });
          await (message.channel as TextChannel).send({ content: `${staffPing} Auto-generation error. Please handle manually.` });

          try {
            const homeGuild = client.guilds.cache.get(CONFIG.GUILD_ID);
            if (homeGuild) {
              await logAction(homeGuild, '🚨 Token Generation Error', `User <@${ticket.userId}> hit a token-gen error for **${ticket.game.name}** (AppID \`${ticket.game.appId}\`):\n\`\`\`\n${detail.slice(0, 800)}\n\`\`\`${hint}`, 0xED4245);
            }
          } catch {}
        }
      } else {
        const newRetryCount = ticket.verification.retryCount + 1;
        await prisma.pendingVerification.update({
          where: { ticketId: ticket.id },
          data: { retryCount: newRetryCount, isProcessing: false }
        });

        const remaining = 3 - newRetryCount;
        const failureEmbed = createVerificationFailureEmbed(remaining, reasoning || 'AI reasoning unavailable.');
        
        if (remaining <= 0) {
          const tTimer = pendingVerificationTimers.get(message.channelId);
          if (tTimer) clearTimeout(tTimer);
          
          await prisma.pendingVerification.delete({ where: { ticketId: ticket.id } });
          
          await waitMessage.edit({ embeds: [failureEmbed] });
          
          const channel = message.channel as TextChannel;
          await triggerSessionFailure(message.channelId, ticket.userId, channel, false);
          await refreshAllPanels();
        } else {
          await waitMessage.edit({ embeds: [failureEmbed] });

          if (message.guild) {
            const homeGuild = client.guilds.cache.get(CONFIG.GUILD_ID);
            if (homeGuild) {
              await logAction(homeGuild, '❌ Screenshot Rejected', `User <@${message.author.id}> provided an invalid screenshot for **${ticket.game.name}**.\n\n**Reasoning:** ${reasoning || 'No details'}\n**Attempts:** \`${newRetryCount}/3\``, 0xED4245);
            }
            if (message.guildId) {
              await logTenant(message.guildId, '❌ Screenshot Rejected', `User <@${message.author.id}> provided an invalid screenshot for **${ticket.game.name}**.\n\n**Reasoning:** ${reasoning || 'No details'}\n**Attempts:** \`${newRetryCount}/3\``, 0xED4245);
            }
          }
          
          const newTimer = setTimeout(async () => {
            if (message.guild) {
              await autoCloseTicketForVerificationTimeout(message.channelId, message.guild);
            }
          }, 10 * 60 * 1000);
          pendingVerificationTimers.set(message.channelId, newTimer);
        }
      }

    }
  }

  // --- NEW: Staff Delivery Detection ---
  const firstAttachment = message.attachments.first();
  if (firstAttachment && firstAttachment.name.toLowerCase().endsWith('.zip') && message.member && await (await import('./utils/permissions')).isStaffForGuild(message.member as GuildMember, message.guildId ?? '')) {
    try {
      const ticket = await prisma.ticket.findFirst({
        where: { channelId: message.channelId },
        include: { game: true }
      });

      if (ticket && (ticket.status === 'OPEN' || ticket.status === 'CLAIMED')) {
        const zipName = firstAttachment.name.toLowerCase();
        const fullGameName = ticket.game.name.toLowerCase();
        const appIdString = ticket.game.appId?.toString();

        // 1. Direct match or appId match
        let isMatch = zipName.includes(fullGameName);
        if (appIdString && zipName.includes(appIdString)) isMatch = true;

        if (!isMatch) {
          // 2. Intelligent Keyword matching (Skip loose acronyms)
          const nameWords = fullGameName.split(/[\s-]+/).filter(w => w.length > 3);
          
          // Check if zip contains significant words from game title
          const matchCount = nameWords.filter(word => zipName.includes(word)).length;
          
          if (matchCount >= 1) {
            isMatch = true;
          }
        }

        if (isMatch) {
          const deliveryEmbed = createTokenDeliveryEmbed(ticket.game.name, ticket.userId, message.author);
          
          const worksRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
             new ButtonBuilder().setCustomId('works_yes').setLabel('Confirm Working').setStyle(ButtonStyle.Success),
             new ButtonBuilder().setCustomId('works_no').setLabel('Report Issue').setStyle(ButtonStyle.Danger)
          );

          const deliveryMsg = await message.channel.send({
            embeds: [deliveryEmbed],
            components: [worksRow]
          });
          
          await prisma.ticket.update({
            where: { id: ticket.id },
            data: { deliveryMessageId: deliveryMsg.id, staffId: message.author.id }
          });

          await message.react('❤️').catch(() => {});
          await deliveryMsg.react('❤️').catch(() => {});

          const guild = message.guild;
          if (guild) {
            await logAction(guild, '📦 Token Delivered', `Staff ${message.author} delivered a token zip for **${ticket.game.name}** in <#${message.channelId}>.`, 0x5865F2);
          }
        }
      }
    } catch (err) {
      console.error('Error in Staff Delivery Detection:', err);
    }
  }

  // --- NEW: Voucher Monitoring (Keep legacy message detection for backward compat, but prioritize reactions) ---
   // Resolve THIS server's voucher channel (tenant override or home env).
  const vouchSc = message.guildId
    ? await (await import('./utils/tenant')).resolveServerConfig(message.guildId)
    : null;
  if (vouchSc && message.channelId === vouchSc.voucherChannelId) {

    // Find any open/claimed ticket for this user — vouchExpiresAt is preferred
    // but we fall back to any open ticket so this still works if the user posts
    // in voucher channel before clicking "Yes, it works!".
    const ticket = await prisma.ticket.findFirst({
      where: { userId: message.author.id, status: { in: ['OPEN', 'CLAIMED'] } },
      include: { game: true },
      orderBy: { createdAt: 'desc' }
    });

    const pingsBot = !!client.user && message.mentions.users.has(client.user.id);
    const hasScreenshot = message.attachments.some(a => a.contentType?.startsWith('image/'));

    console.log(
      `[VouchAuto] msg in voucher channel by ${message.author.tag} | ` +
      `ticket=${ticket ? ticket.id : 'none'} | pingsBot=${pingsBot} | hasScreenshot=${hasScreenshot} | ` +
      `attachments=[${message.attachments.map(a => `${a.name}(${a.contentType})`).join(', ')}]`
    );

    if (ticket) {
      // ─── ENFORCE VOUCH FORMAT ───
      // User has an open ticket → they must vouch with BOTH a bot-ping AND a screenshot.
      // If they're missing either, delete the message and post a self-deleting reminder.
      if (!pingsBot || !hasScreenshot) {
        const missing: string[] = [];
        if (!pingsBot) missing.push(`Ping the bot (<@${client.user?.id}>)`);
        if (!hasScreenshot) missing.push('Attach a screenshot of the game running');

        const guideEmbed = new EmbedBuilder()
          .setTitle('⚠️ Vouch Format Incorrect')
          .setDescription(
            `<@${message.author.id}>, your vouch was removed because it was missing:\n\n` +
            missing.map(m => `• ${m}`).join('\n') +
            `\n\n**Post again with BOTH:**\n` +
            `1. A mention of <@${client.user?.id}>\n` +
            `2. A screenshot attachment of the game running\n\n` +
            `*This reminder will disappear in 30 seconds.*`
          )
          .setColor(0xED4245)
          .setTimestamp();

        // Delete the user's malformed message first
        await message.delete().catch(() => {});

        // Post a self-deleting reminder pinging only the user
        if (message.channel && 'send' in message.channel) {
          const reminder = await (message.channel as TextChannel).send({
            content: `<@${message.author.id}>`,
            embeds: [guideEmbed],
            allowedMentions: { users: [message.author.id] }
          }).catch(() => null);
          if (reminder) setTimeout(() => reminder.delete().catch(() => {}), 30000);
        }

        return;
      }

      // Bot reacts to confirm it detected the vouch
      await message.react('❤️').catch(() => {});

      // ─── FAST-PATH AUTO-CLOSE ───
      // If the user pings the bot AND attaches a screenshot, finalize immediately:
      //   • cooldown based on game's tier (2h donor, 48h high, 24h normal/booster)
      //   • token deducted
      //   • ticket closed and channel deleted

      if (pingsBot && hasScreenshot) {
        try {
          // Clear any pending vouch timeout — we're closing now
          const vTimer = vouchTimers.get(ticket.userId);
          if (vTimer) {
            clearTimeout(vTimer);
            vouchTimers.delete(ticket.userId);
          }

          // Cooldown based on game's tier (set via /game tier)
          // Donor games:  2h  — donors get a fast reset as a perk
          // High demand:  48h — slow down repeat requests on popular games
          // Booster/Normal: 24h — standard
          const g = ticket.game as any;
          const cooldownHours = g.donatorOnly ? 2 : g.highDemand ? 48 : 24;
          const until = new Date(Date.now() + cooldownHours * 60 * 60 * 1000);
          await prisma.cooldown.upsert({
            where: { userId: ticket.userId },
            update: { until },
            create: { userId: ticket.userId, until }
          });

          // Deduct one token from stock
          await consumeStock(ticket.gameId).catch((e) => console.error('[VouchAuto] consumeStock failed:', e));

          // Close ticket
          await prisma.ticket.update({
            where: { id: ticket.id },
            data: {
              status: 'CLOSED',
              closedAt: new Date(),
              screenshotVerified: true,
              vouchExpiresAt: null
            }
          });

          // Notify ticket channel + delete it
          const ticketChannel = await client.channels.fetch(ticket.channelId).catch(() => null) as TextChannel | null;
          if (ticketChannel) {
            const closeEmbed = new EmbedBuilder()
              .setTitle('✅ Vouch Auto-Verified')
              .setDescription(`Vouch + screenshot detected. Session closed.\n\n**Cooldown:** \`${cooldownHours}h\`\n**Token Deducted:** \`YES\``)
              .setColor(0x57F287)
              .setTimestamp();
            await ticketChannel.send({ embeds: [closeEmbed] }).catch(() => {});
            setTimeout(() => ticketChannel.delete().catch(() => {}), 5000);
          }

          // Log
          if (message.guild) {
            await logAction(
              message.guild,
              '🤖 Vouch Auto-Closed',
              `Bot auto-closed session for <@${ticket.userId}> after vouch (ping + screenshot) in <#${message.channelId}>.\n\n**Game:** ${ticket.game.name}\n**Cooldown:** \`${cooldownHours}h\`\n**Token Deducted:** \`YES\``,
              0x57F287
            );
          }

          await refreshAllPanels();
        } catch (err) {
          console.error('[VouchAuto] Failed to auto-close on ping+screenshot:', err);
        }
      }
    }
  }
});

// --- NEW: Reaction-Based Vouch Verification (Moved outside MessageCreate) ---
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot && user.id !== client.user?.id) return;
  if (reaction.emoji.name !== '❤️') return;

  try {
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message as Message;
    const rxSc = message.guildId
      ? await (await import('./utils/tenant')).resolveServerConfig(message.guildId)
      : null;
    if (!rxSc || message.channelId !== rxSc.voucherChannelId) return;


    // The user who sent the vouch message
    const vouchAuthorId = message.author.id;

    const ticket = await prisma.ticket.findFirst({
      where: {
        userId: vouchAuthorId,
        vouchExpiresAt: { not: null },
        status: { in: ['OPEN', 'CLAIMED'] }
      }
    });

    if (ticket) {
      const assistsStaff = ticket.staffId === user.id;
      const isSystemConfirm = user.id === client.user?.id;

      // Security: a user reacting to their OWN vouch must not be enough to close
      // the ticket — that defeats the purpose of vouching. Only the assigned staff
      // who delivered the token, or the bot itself, can confirm via reaction.
      if (assistsStaff || isSystemConfirm) {
        const vTimer = vouchTimers.get(ticket.userId);
        if (vTimer) {
           clearTimeout(vTimer);
           vouchTimers.delete(ticket.userId);
        }

        const ticketWithGame = await prisma.ticket.findUnique({ where: { id: ticket.id }, include: { game: true } });
        const g = ticketWithGame?.game as any;
        const cooldownHours = g?.donatorOnly ? 2 : g?.highDemand ? 48 : 24;
        const until = new Date(Date.now() + cooldownHours * 60 * 60 * 1000);
        await prisma.cooldown.upsert({ where: { userId: ticket.userId }, update: { until }, create: { userId: ticket.userId, until } });

        await prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'CLOSED', closedAt: new Date(), vouchExpiresAt: null } });

        const channel = await client.channels.fetch(ticket.channelId).catch(() => null) as TextChannel;
        if (channel) {
          const successEmbed = new EmbedBuilder()
            .setTitle('✅ Vouch Verified')
            .setDescription(`Vouch confirmed by **${user.id === client.user?.id ? 'System' : user.username}**. Session closed with \`${cooldownHours}h\` cooldown.`)
            .setColor(0x57F287)
            .setTimestamp();
          await channel.send({ embeds: [successEmbed] });
          setTimeout(() => channel.delete().catch(() => {}), 10000);
        }

        const homeGuild = client.guilds.cache.get(CONFIG.GUILD_ID);
        if (homeGuild) {
          await logAction(homeGuild, '✅ Vouch Verified (Reaction)', `Vouch for <@${ticket.userId}> confirmed by <@${user.id}> via '❤️' reaction. Ticket closed.`, 0x57F287);
        }
        if (message.guildId) {
          await logTenant(message.guildId, '✅ Vouch Verified (Reaction)', `Vouch for <@${ticket.userId}> confirmed by <@${user.id}> via '❤️' reaction. Ticket closed.`, 0x57F287);
        }
        await refreshAllPanels();
      }
    }
  } catch (err) {
    console.error('Error in MessageReactionAdd:', err);
  }
});

async function checkActiveMaintenance() {
  try {
    const sessions = await prisma.maintenance.findMany();
    for (const session of sessions) {
      const now = new Date();
      if (session.endTime <= now) {
        await resumeFromMaintenance(session.channelId, session.messageId);
      } else {
        const remainingMs = session.endTime.getTime() - now.getTime();
        console.log(`[Maintenance] Resuming session in ${session.channelId} in ${Math.ceil(remainingMs / 60000)}m`);
        setTimeout(() => resumeFromMaintenance(session.channelId, session.messageId), remainingMs);
      }
    }
  } catch (err) {
    console.error('[Maintenance] Failed to check active sessions on boot:', err);
  }
}



// --- Background Cycles ---
setInterval(() => updateTicketWaitTimes(client), 60 * 1000); // Live Wait Updates (Every 1m)
setInterval(() => checkWeeklyStaffStats(client), 15 * 60 * 1000); // Weekly Check (Every 15m for precision)
setInterval(() => checkDutyStatusReset(), 30 * 60 * 1000); // Duty Reset (Every 30m)
setInterval(() => checkStaleTickets(client), 10 * 60 * 1000); // Stale Tickets (Every 10m)
setInterval(() => cleanupExpiredCooldowns(), 6 * 60 * 60 * 1000); // Bug #15: Cooldown Cleanup (Every 6h)
// Token downloads have a 30-minute TTL; sweep every 5 minutes to delete
// the stored zip file + DB row once the link expires.
setInterval(() => {
  import('./utils/downloadHost').then(m => m.cleanupExpiredDownloads().catch(() => {}));
}, 5 * 60 * 1000);

// --- Process-level error handlers (prevents silent crashes) ---
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
  // Don't exit — let Discord.js reconnect on transient errors.
  // Real fatal errors (out-of-memory) will exit on their own.
});

// --- Login with graceful failure logging ---
(async () => {
  if (!CONFIG.TOKEN) {
    console.error('[Boot] DISCORD_TOKEN is not set. Cannot start the bot.');
    process.exit(1);
  }
  try {
    await client.login(CONFIG.TOKEN);
  } catch (err) {
    const e = err as Error;
    console.error('[Boot] Failed to log in to Discord:', e.message);
    if (e.message.includes('TokenInvalid') || e.message.includes('invalid token')) {
      console.error('[Boot] → The DISCORD_TOKEN environment variable is invalid or has been reset.');
      console.error('[Boot] → Reset it in the Discord Developer Portal and update Railway Variables.');
    }
    process.exit(1);
  }
})();
