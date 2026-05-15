import { client } from './client';
import { CONFIG } from './config';
import path from 'path';
import { REST, Routes, InteractionType, PermissionsBitField, SlashCommandBuilder, TextChannel, AttachmentBuilder, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType, TextBasedChannel, MessageFlags, EmbedBuilder, Message, GuildMember } from 'discord.js';
import { createMainPanel, createMaintenancePanel, createVerificationProcessingEmbed, createVerificationSuccessEmbed, createVerificationFailureEmbed, createProfileEmbed, createStaffLookupEmbed, createTokenDeliveryEmbed, createVouchRequestEmbed } from './utils/embeds';
import { createTicket, claimTicket, closeTicket, handleCooldownSelection, handleDeductionChoice, unclaimTicket, autoCloseTicketForVerificationTimeout, triggerSessionFailure, pendingVerificationTimers, vouchTimers } from './utils/ticketManager';
import { getStaffStats, getEstimatedWaitTime } from './utils/stats';
import { updateStock, consumeStock } from './utils/gameManager';
import prisma from './lib/prisma';
import { logAction } from './utils/logging';
import { refreshAllPanels } from './utils/panelManager';
import { verifyScreenshot } from './utils/groq';
import { initFileWatcher, syncGamesFromFile } from './utils/syncManager';
import { generateToken, generateTestToken } from './utils/tokenGenerator';
import { uploadFile } from './utils/fileHost';
import { updateTicketWaitTimes, checkWeeklyStaffStats, checkDutyStatusReset, checkStaleTickets, cleanupExpiredCooldowns } from './utils/scheduler';
import { toggleDuty } from './utils/dutyManager';
import { addSubscription, getUserSubscriptions } from './utils/subscriptionManager';
import { isStaff } from './utils/permissions';

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
    .setDescription('Set the token-generation mode for a game (gbe / coldloader / coldclientloader)')
    .addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('mode').setDescription('Output layout').setRequired(true).addChoices(
      { name: 'GBE Normal (flat: steam_api64 + steamclient64 + steam_settings)', value: 'gbe' },
      { name: 'ColdLoader V2 (DLL hijack via version/dinput8/winmm)', value: 'coldloader' },
      { name: 'ColdClientLoader V1 (launcher .exe)', value: 'coldclientloader' },
    ))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(CONFIG.TOKEN);

async function registerCommands() {
  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: [] });
    await rest.put(Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID), { body: commands });
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`${CONFIG.NAME} is online!`);
  await registerCommands();
  
  client.user?.setActivity('Denuvo Activations', { type: ActivityType.Watching });
  
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
        const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
        if (guild) {
          await autoCloseTicketForVerificationTimeout(ticket.channelId, guild);
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
      const payload = { content: `❌ **Interaction Error:** ${err.message}` };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply({ ...payload, flags: [MessageFlags.Ephemeral] }).catch(() => {});
      }
    }
  }
});

async function handleAutocomplete(interaction: any) {
  if (interaction.commandName === 'stock' || interaction.commandName === 'exclude-auto' || interaction.commandName === 'test' || interaction.commandName === 'tokengen' || interaction.commandName === 'setmode') {
    const focusedValue = interaction.options.getFocused();
    const games = await prisma.game.findMany({
      where: { name: { contains: focusedValue, mode: 'insensitive' } },
      take: 25
    });
    await interaction.respond(games.map((g: { name: string }) => ({ name: g.name, value: g.name })));
  }
}

async function handleChatCommand(interaction: any) {
  const channel = interaction.channel;
  const isStaffStats = interaction.commandName === 'staffstats';
  // /tokengen is public (other members can see the result), like staffstats.
  const isPublic = isStaffStats || interaction.commandName === 'tokengen';
  await interaction.deferReply({ flags: isPublic ? [] : [MessageFlags.Ephemeral] });
  
  if (interaction.commandName === 'postpanel') {
    if (channel?.isTextBased() && 'send' in channel) {
      await postMainPanel(channel as TextBasedChannel);
      await interaction.editReply({ content: '✅ **Panel posted!** Autorefresh is active.' });
    }
  } else if (interaction.commandName === 'closepanel') {
    const duration = interaction.options.getInteger('duration');

    if (channel?.isTextBased()) {
      const panels = await prisma.panel.findMany({ where: { channelId: interaction.channelId } });
      for (const p of panels) {
        try {
          if ('messages' in channel) {
            const msg = await (channel as TextChannel).messages.fetch(p.messageId);
            if (msg) await msg.delete().catch(() => {});
          }
        } catch (e) {}
      }
      await prisma.panel.deleteMany({ where: { channelId: interaction.channelId } }).catch(() => {});

      const maintenancePanel = await createMaintenancePanel(duration);
      const mntPath = path.join(__dirname, 'public/maintenance.png');
      const attachment = new AttachmentBuilder(mntPath, { name: 'maintenance.png' });
      
      let maintenanceMessage: Message | null = null;
      if (channel && 'send' in channel) {
        maintenanceMessage = await (channel as TextChannel).send({ ...maintenancePanel, files: [attachment] });
      }

      if (duration && duration > 0) {
        const endTime = new Date(Date.now() + duration * 60000);
        
        if (maintenanceMessage) {
          await prisma.maintenance.create({
            data: { channelId: interaction.channelId, messageId: maintenanceMessage.id, endTime: endTime }
          }).catch((e: Error) => console.error('Failed to persist maintenance state:', e));
        }

        await interaction.editReply({ content: `✅ **Maintenance Active:** Dashboard switch triggered. System will auto-resume in **${duration} minutes**.` });
        setTimeout(() => resumeFromMaintenance(interaction.channelId, maintenanceMessage?.id), duration * 60000);
      } else {
        await interaction.editReply({ content: '✅ **Dashboard Switch:** Maintenance mode activated.' });
      }
    }
  } else if (interaction.commandName === 'stock') {
    const sub = interaction.options.getSubcommand() as 'add' | 'remove' | 'set' | 'clear';
    const gameName = interaction.options.getString('game')!;
    const amount = interaction.options.getInteger('amount') || 0;
    await updateStock(gameName, sub, amount);
    await refreshAllPanels();
    await interaction.editReply({ content: `✅ **Systems Sync:** Stock for **${gameName}** updated.` });
  } else if (interaction.commandName === 'cooldown') {
    const user = interaction.options.getUser('user')!;
    await prisma.cooldown.deleteMany({ where: { userId: user.id } });
    await prisma.ticket.updateMany({ 
      where: { userId: user.id, status: 'CLOSED', screenshotVerified: false }, 
      data: { screenshotVerified: true } 
    });
    await interaction.editReply({ content: `✅ **Restriction Lifted:** Cooldown cleared and strikes reset for ${user}.` });
  } else if (interaction.commandName === 'mycooldown') {
    const cooldown = await prisma.cooldown.findUnique({ where: { userId: interaction.user.id } });
    if (cooldown && cooldown.until > new Date()) {
      const timeLeft = Math.ceil((cooldown.until.getTime() - Date.now()) / (1000 * 60 * 60));
      const exp = Math.floor(cooldown.until.getTime() / 1000);
      await interaction.editReply({ content: `🛡️ **Denuvo Status:** Active Cooldown\n━━━━━━━━━━━━━━━━━━━━\n⌛ **Duration Remaining:** \`${timeLeft} hours\`\n📅 **Expiration:** <t:${exp}:f>\n━━━━━━━━━━━━━━━━━━━━\n*Further activation attempts are locked until expiry.*` });
    } else {
      await interaction.editReply({ content: `✅ **Denuvo Status:** Cleared\nYour account is currently in good standing. No active cooldowns detected.` });
    }
  } else if (interaction.commandName === 'staffstats') {
    const stats = await getStaffStats();
    if (stats.length === 0) return interaction.editReply({ content: '📊 **Staff Stats:** No activity recorded.' });

    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const embed = new EmbedBuilder()
      .setTitle('🏆 Staff performance Leaderboard')
      .setDescription(`Top staff members in the last **7 days**.\n*Resolved since <t:${Math.floor(oneWeekAgo.getTime() / 1000)}:d>.*`)
      .setColor(0x5865F2)
      .setTimestamp();

    let statsList = '';
    for (let i = 0; i < stats.length; i++) {
      const stat = stats[i];
      const user = await client.users.fetch(stat.staffId!).catch(() => null);
      const ticketCount = stat._count?.id ?? 0;
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '👤';
      statsList += `${medal} **${user ? user.username : 'Unknown'}**: \`${ticketCount} Tickets\`\n`;
    }

    const nextMeta = await prisma.metadata.findUnique({ where: { key: 'lastWeeklyStatsAt' } });
    const lastDate = nextMeta ? new Date(nextMeta.value) : new Date(0);
    const nextTimestamp = Math.floor((lastDate.getTime() + 7 * 24 * 60 * 60 * 1000) / 1000);

    embed.addFields(
      { name: '📊 Merit Metrics', value: statsList || 'No data.', inline: false },
      { name: '⏱️ Next Cycle', value: `<t:${nextTimestamp}:R>`, inline: true }
    );
    await interaction.editReply({ embeds: [embed] });
  } else if (interaction.commandName === 'onduty') {
    if (!isStaff(interaction.member as GuildMember)) return interaction.editReply({ content: '❌ **Unauthorized.**' });
    const state = await toggleDuty(interaction.user.id);
    await refreshAllPanels();
    await interaction.editReply({ content: state ? '🟢 **Reporting for Duty:** Active.' : '🌙 **Duty Cycle Ended:** Away.' });
  } else if (interaction.commandName === 'profile') {
    const cooldown = await prisma.cooldown.findUnique({ where: { userId: interaction.user.id } });
    const subs = await getUserSubscriptions(interaction.user.id);
    const total = await prisma.ticket.count({ where: { userId: interaction.user.id, status: 'CLOSED' } });
    await interaction.editReply({ embeds: [createProfileEmbed(interaction.user, cooldown, subs, total, interaction.member as GuildMember)] });
  } else if (interaction.commandName === 'lookup') {
    const target = interaction.options.getUser('user')!;
    const cooldown = await prisma.cooldown.findUnique({ where: { userId: target.id } });
    const history = await prisma.ticket.findMany({ where: { userId: target.id }, take: 5, orderBy: { createdAt: 'desc' } });
    await interaction.editReply({ embeds: [createStaffLookupEmbed(target, history, cooldown)] });
  } else if (interaction.commandName === 'test') {
    const gameName = interaction.options.getString('game')!;
    const game = await prisma.game.findUnique({ where: { name: gameName } });
    if (!game) return interaction.editReply({ content: `❌ **Not Found:** Game **${gameName}** does not exist.` });
    if (!game.appId) return interaction.editReply({ content: `❌ **No AppID:** Game **${gameName}** has no AppID configured.` });

    const startEmbed = new EmbedBuilder()
      .setTitle('🧪 Generating TEST Token')
      .setDescription(`Building a test zip for **${game.name}** (AppID: \`${game.appId}\`).\nUses fake credentials — no Steam authentication, no stock consumed.`)
      .setColor(0xFEE75C)
      .setTimestamp();
    await interaction.editReply({ embeds: [startEmbed] });

    try {
      const { zipPath, logs } = await generateTestToken(game.appId, game.name);
      console.log(`[TestToken] Logs for ${game.name}:\n${logs}`);

      if (zipPath) {
        const safeGameName = game.name.replace(/[<>:"/\\|?*]/g, '').trim();
        const fs = await import('fs');
        const sizeBytes = fs.statSync(zipPath).size;
        const sizeMB = sizeBytes / (1024 * 1024);
        const guild = interaction.guild;
        const tier = guild?.premiumTier ?? 0;
        const limitMB = tier >= 3 ? 100 : tier >= 2 ? 50 : 10;

        try {
          if (sizeMB <= limitMB) {
            // Fits — attach directly
            const zipFile = new AttachmentBuilder(zipPath, { name: `TEST [${safeGameName}].zip` });
            const successEmbed = new EmbedBuilder()
              .setTitle('🧪 TEST Token Generated')
              .setDescription(`**${game.name}** template built successfully.\n\n⚠️ **This is a TEST zip** — the ticket inside is a placeholder string \`FAKE_TEST_TICKET_DO_NOT_USE...\`. The DLLs, configs, and structure are real. Use this to verify the template ships correctly.`)
              .setColor(0x57F287)
              .addFields(
                { name: 'AppID', value: `\`${game.appId}\``, inline: true },
                { name: 'Steam ID', value: `\`76561199000000001\``, inline: true },
                { name: 'Zip Size', value: `\`${sizeMB.toFixed(1)} MB\``, inline: true }
              )
              .setTimestamp();
            await interaction.editReply({ embeds: [successEmbed], files: [zipFile] });
          } else {
            // Too big — upload to file host and post a link
            console.log(`[TestToken] Zip ${sizeMB.toFixed(1)} MB > ${limitMB} MB limit — uploading to file host`);
            await interaction.editReply({ embeds: [
              new EmbedBuilder()
                .setTitle('📤 Uploading TEST Token')
                .setDescription(`Zip is **${sizeMB.toFixed(1)} MB** (Discord limit here is ${limitMB} MB). Uploading to external host...`)
                .setColor(0xFEE75C)
                .setTimestamp()
            ]});
            const upload = await uploadFile(zipPath, '24h');
            const filenameNote = upload.provider === 'gofile'
              ? `The link opens a download page — click **Download** there to save \`TEST [${safeGameName}].zip\` (filename preserved).`
              : `Direct download. File will arrive named with a random hash.`;
            const hostedEmbed = new EmbedBuilder()
              .setTitle('🧪 TEST Token Generated (External)')
              .setDescription(
                `**${game.name}** template built successfully — too big to attach (${sizeMB.toFixed(1)} MB), uploaded via ${upload.provider}.\n\n` +
                `**[⬇️ Download TEST Zip](${upload.url})**\n\n` +
                filenameNote + `\n\n` +
                `⚠️ Fake ticket inside — DO NOT use against a real game.\n` +
                `⏱️ ${upload.expiryText}.`
              )
              .setColor(0x57F287)
              .addFields(
                { name: 'AppID', value: `\`${game.appId}\``, inline: true },
                { name: 'Size', value: `\`${sizeMB.toFixed(1)} MB\``, inline: true }
              )
              .setTimestamp();
            await interaction.editReply({ embeds: [hostedEmbed] });
          }
        } catch (sendErr) {
          const se = sendErr as Error;
          await interaction.editReply({ embeds: [
            new EmbedBuilder()
              .setTitle('🧪 TEST Token — Upload Failed')
              .setDescription(`Built successfully but failed to deliver.\n\n\`\`\`\n${(se?.message || String(se)).slice(0, 400)}\n\`\`\``)
              .setColor(0xED4245)
          ]}).catch(() => {});
        } finally {
          try { fs.unlinkSync(zipPath); } catch {}
        }
      } else {
        const failEmbed = new EmbedBuilder()
          .setTitle('🧪 TEST Token Failed')
          .setDescription(`Could not generate test zip for **${game.name}**.\n\n\`\`\`\n${logs.slice(-500)}\n\`\`\``)
          .setColor(0xED4245)
          .setTimestamp();
        await interaction.editReply({ embeds: [failEmbed] });
      }
    } catch (err) {
      const e = err as Error;
      console.error('[TestToken] Error:', e);
      await interaction.editReply({ content: `❌ **Test Token Error:** ${e.message}` });
    }
  } else if (interaction.commandName === 'tokengen') {
    // /tokengen — staff-only command that generates a REAL token, posts publicly,
    // skips screenshot verification, and optionally deducts stock. Independent
    // of the ticket flow — does not touch tickets, cooldowns, or vouches.
    const gameName = interaction.options.getString('game')!;
    const deduct = interaction.options.getBoolean('deduct') ?? true;

    if (!isStaff(interaction.member as GuildMember)) {
      return interaction.editReply({ content: '❌ **Unauthorized:** Staff clearance required.' });
    }

    const game = await prisma.game.findUnique({ where: { name: gameName } });
    if (!game) return interaction.editReply({ content: `❌ **Not Found:** Game **${gameName}** does not exist.` });
    if (!game.appId) return interaction.editReply({ content: `❌ **No AppID:** Game **${gameName}** has no AppID configured.` });

    const startEmbed = new EmbedBuilder()
      .setTitle('⚙️ Generating Token (Staff Bypass)')
      .setDescription(`Generating a real token for **${game.name}** (AppID: \`${game.appId}\`).\n*Requested by ${interaction.user}.*\nDeduct stock: \`${deduct ? 'YES' : 'NO'}\``)
      .setColor(0x5865F2)
      .setTimestamp();
    await interaction.editReply({ embeds: [startEmbed] });

    try {
      const { zipPath, logs } = await generateToken(game.appId, game.name);
      console.log(`[TokenGen-Cmd] Logs for ${game.name}:\n${logs}`);

      if (!zipPath) {
        const failEmbed = new EmbedBuilder()
          .setTitle('⚠️ Token Generation Failed')
          .setDescription(`Could not generate token for **${game.name}**.\n\n\`\`\`\n${logs.slice(-500)}\n\`\`\``)
          .setColor(0xED4245)
          .setTimestamp();
        await interaction.editReply({ embeds: [failEmbed] });
        if (interaction.guild) {
          await logAction(interaction.guild, '⚠️ /tokengen Failed', `Staff ${interaction.user} ran /tokengen for **${game.name}** — generation failed.\n\`\`\`\n${logs.slice(-500)}\n\`\`\``, 0xED4245);
        }
        return;
      }

      // Deduct stock first (so the deduction is recorded even if Discord upload fails)
      if (deduct) {
        await consumeStock(game.id).catch(e => console.error('[TokenGen-Cmd] consumeStock failed:', e));
      }

      const safeGameName = game.name.replace(/[<>:"/\\|?*]/g, '').trim();
      const fsMod = await import('fs');
      const zipBytes = fsMod.statSync(zipPath).size;
      const zipMB = zipBytes / (1024 * 1024);
      const tier = interaction.guild?.premiumTier ?? 0;
      const limitMB = tier >= 3 ? 100 : tier >= 2 ? 50 : 10;

      const successFields = [
        { name: '🎮 Game', value: `\`${game.name}\``, inline: true },
        { name: '🆔 AppID', value: `\`${game.appId}\``, inline: true },
        { name: '📦 Size', value: `\`${zipMB.toFixed(1)} MB\``, inline: true },
        { name: '🛠️ Generated by', value: `${interaction.user}`, inline: true },
        { name: '💰 Stock Deducted', value: `\`${deduct ? 'YES' : 'NO'}\``, inline: true },
        { name: '📋 Method', value: '`/tokengen` (staff bypass)', inline: true },
      ];

      try {
        if (zipMB <= limitMB) {
          // Attach directly to the channel
          const zipFile = new AttachmentBuilder(zipPath, { name: `Token [${safeGameName}].zip` });
          const successEmbed = new EmbedBuilder()
            .setTitle(`📦 ${CONFIG.NAME} • Token Delivery`)
            .setDescription(`Token for **${game.name}** generated by ${interaction.user}.\n\n⚠️ **CRITICAL INSTRUCTIONS**\n1. Extract the zip into your game folder.\n2. **NEVER** launch the game from Steam.\n3. Always use the **.exe** located in your game folder.`)
            .setColor(0x57F287)
            .addFields(successFields)
            .setTimestamp();
          await interaction.editReply({ embeds: [successEmbed], files: [zipFile] });
        } else {
          // Upload to file host
          await interaction.editReply({ embeds: [
            new EmbedBuilder()
              .setTitle('📤 Uploading Token')
              .setDescription(`Zip is **${zipMB.toFixed(1)} MB** (Discord limit here is ${limitMB} MB). Uploading to file host...`)
              .setColor(0xFEE75C)
              .setTimestamp()
          ] });
          const upload = await uploadFile(zipPath, '72h');
          const filenameNote = upload.provider === 'gofile'
            ? `Click the link → click **Download** on the gofile page → file saves as \`Token [${safeGameName}].zip\`.`
            : `Direct download link. File will arrive with a random filename — rename to \`Token [${safeGameName}].zip\` if you want it organized.`;
          const hostedEmbed = new EmbedBuilder()
            .setTitle(`📦 ${CONFIG.NAME} • Token Delivery (External)`)
            .setDescription(
              `Token for **${game.name}** generated by ${interaction.user}.\n\n` +
              `**[⬇️ Download Token Zip](${upload.url})**\n\n${filenameNote}\n\n` +
              `⚠️ **CRITICAL INSTRUCTIONS**\n` +
              `1. Download the zip from the link above.\n` +
              `2. Extract it into your game folder.\n` +
              `3. **NEVER** launch the game from Steam.\n` +
              `4. Always use the **.exe** located in your game folder.\n\n` +
              `⏱️ ${upload.expiryText}.`
            )
            .setColor(0x57F287)
            .addFields(successFields)
            .setTimestamp();
          await interaction.editReply({ embeds: [hostedEmbed] });
        }

        if (interaction.guild) {
          await logAction(interaction.guild, '🛠️ /tokengen Delivered', `Staff ${interaction.user} generated a token via **/tokengen** for **${game.name}** (AppID \`${game.appId}\`, ${zipMB.toFixed(1)} MB).\n**Stock Deducted:** \`${deduct ? 'YES' : 'NO'}\``, 0x57F287);
        }
      } catch (sendErr) {
        const se = sendErr as Error;
        console.error('[TokenGen-Cmd] Delivery failed:', se);
        await interaction.editReply({ embeds: [
          new EmbedBuilder()
            .setTitle('⚠️ Token Built But Failed to Send')
            .setDescription(`Token generation succeeded but delivery failed:\n\`\`\`\n${(se?.message || String(se)).slice(0, 400)}\n\`\`\``)
            .setColor(0xED4245)
        ] }).catch(() => {});
      } finally {
        // Clean up the zip from disk; gofile/discord has its own copy
        try { fsMod.unlinkSync(zipPath); } catch {}
      }
    } catch (err) {
      const e = err as Error;
      console.error('[TokenGen-Cmd] Error:', e);
      await interaction.editReply({ content: `❌ **/tokengen Error:** ${e.message}` });
    }
  } else if (interaction.commandName === 'setmode') {
    const gameName = interaction.options.getString('game')!;
    const mode = interaction.options.getString('mode')!;

    const game = await prisma.game.findUnique({ where: { name: gameName } });
    if (!game) return interaction.editReply({ content: `❌ **Not Found:** Game **${gameName}** does not exist.` });

    const oldMode = (game as any).generationMode || 'gbe';
    await prisma.game.update({ where: { id: game.id }, data: { generationMode: mode } as any });

    const modeLabel: Record<string, string> = {
      'gbe': 'GBE Normal (flat: steam_api64 + steamclient64 + steam_settings)',
      'coldloader': 'ColdLoader V2 (DLL hijack)',
      'coldclientloader': 'ColdClientLoader V1 (launcher .exe)',
    };

    await interaction.editReply({
      content: `✅ **Mode Updated:** **${gameName}** will now generate tokens using **${modeLabel[mode] || mode}**.\n*(Previously: \`${oldMode}\`)*\n\nNext ticket opened for this game will use the new mode.`
    });

    if (interaction.guild) {
      await logAction(interaction.guild, '⚙️ Generation Mode Changed', `Staff ${interaction.user} switched **${gameName}** from \`${oldMode}\` to \`${mode}\`.`, 0x5865F2);
    }
  } else if (interaction.commandName === 'exclude-auto') {
    const gameName = interaction.options.getString('game')!;
    const state = interaction.options.getString('state')!;
    const exclude = state === 'on';

    const game = await prisma.game.findUnique({ where: { name: gameName } });
    if (!game) return interaction.editReply({ content: `❌ **Not Found:** Game **${gameName}** does not exist.` });

    await prisma.game.update({ where: { id: game.id }, data: { excludeRegen: exclude } });

    // If excluding, also clean up any pending restocks for this game
    if (exclude) {
      const deleted = await prisma.restock.deleteMany({ where: { gameId: game.id } });
      if (deleted.count > 0) {
        await interaction.editReply({ content: `🔒 **Regen Excluded:** **${gameName}** will no longer auto-regenerate stock. Cleared **${deleted.count}** pending restock(s).` });
      } else {
        await interaction.editReply({ content: `🔒 **Regen Excluded:** **${gameName}** will no longer auto-regenerate stock.` });
      }
    } else {
      await interaction.editReply({ content: `🔓 **Regen Enabled:** **${gameName}** will now auto-regenerate stock as normal.` });
    }
  }
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
    const vouchEmbed = createVouchRequestEmbed(CONFIG.VOUCHER_CHANNEL_ID, ticket.staffId!, client.user!.id);
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
    const failureHelpEmbed = new EmbedBuilder()
      .setTitle('⚠️ Issue Reported')
      .setDescription(`System alerted activators (<@&${CONFIG.ACTIVATORS_ROLE_ID}>). Please wait.`)
      .setColor(0xED4245)
      .setTimestamp();

    if (interaction.channel && 'send' in interaction.channel) {
      await (interaction.channel as TextChannel).send({ embeds: [failureHelpEmbed] });
      await (interaction.channel as TextChannel).send({ content: `<@&${CONFIG.ACTIVATORS_ROLE_ID}>, user <@${interaction.user.id}> reported issues.` });
    }

    const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
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
             data: { status: 'CLOSED' }
           });
 
           // Bug #6 fix: Clean up in-memory maps when member leaves
           const timer = pendingVerificationTimers.get(ticket.channelId);
           if (timer) {
             clearTimeout(timer);
             pendingVerificationTimers.delete(ticket.channelId);
           }


           const channel = (await client.channels.fetch(ticket.channelId).catch(() => null)) as TextChannel;
           if (channel) {
             await channel.send({ content: `🔒 **Denuvo Check:** Requester has left the server. Session terminated. Closing in 5s.` }).catch(() => {});
             setTimeout(() => channel.delete().catch(() => {}), 5000);
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
        
        const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
        if (guild) {
          await logAction(guild, '✅ Screenshot Verified', `User ${message.author} has posted a valid screenshot for **${ticket.game.name}** in <#${message.channelId}>.`, 0x57F287);
        }

        // ─── AUTO-GENERATE TOKEN ───
        const genEmbed = new EmbedBuilder()
          .setTitle('⚙️ Generating Token...')
          .setDescription(`Denuvo token is being generated for **${ticket.game.name}** (AppID: \`${ticket.game.appId}\`).\nPlease wait, this may take up to 30 seconds.`)
          .setColor(0x5865F2)
          .setTimestamp();
        const genMsg = await (message.channel as TextChannel).send({ embeds: [genEmbed] });

        try {
          const appId = ticket.game.appId;
          if (!appId) throw new Error('Game has no AppID configured.');

          const { zipPath, logs } = await generateToken(appId, ticket.game.name);
          console.log(`[TokenGen] Logs for ${ticket.game.name}:\n${logs}`);

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

            if (zipMB > limitMB) {
              console.log(`[TokenGen] Zip ${zipMB.toFixed(1)} MB > ${limitMB} MB Discord limit (boost tier ${tier}) — uploading to file host instead`);

              const uploadingEmbed = new EmbedBuilder()
                .setTitle('📤 Uploading Token to External Host')
                .setDescription(
                  `The zip is **${zipMB.toFixed(1)} MB** — too large for this server's Discord upload limit (${limitMB} MB).\n\n` +
                  `Uploading to a file host so you can download it directly. This takes up to a minute for large files.`
                )
                .setColor(0xFEE75C)
                .setTimestamp();
              await genMsg.edit({ embeds: [uploadingEmbed] });

              let upload: Awaited<ReturnType<typeof uploadFile>> | null = null;
              try {
                upload = await uploadFile(zipPath, '72h');
                console.log(`[TokenGen] Uploaded via ${upload.provider}: ${upload.url}`);
              } catch (uploadErr) {
                const ue = uploadErr as Error;
                console.error('[TokenGen] Litterbox upload failed:', ue);
                const failEmbed = new EmbedBuilder()
                  .setTitle('⚠️ External Upload Failed')
                  .setDescription(
                    `Zip is too large for Discord (${zipMB.toFixed(1)} MB > ${limitMB} MB) and the backup file host upload failed.\n\n` +
                    `\`\`\`\n${(ue?.message || String(ue)).slice(0, 300)}\n\`\`\`\n` +
                    `Staff has been notified for manual delivery.`
                  )
                  .setColor(0xED4245)
                  .setTimestamp();
                await genMsg.edit({ embeds: [failEmbed] });
                await (message.channel as TextChannel).send({ content: `<@&${CONFIG.STAFF_ROLE_ID}> Auto-gen worked but the zip is ${zipMB.toFixed(1)} MB and won't fit Discord (${limitMB} MB). External upload also failed. Manual delivery needed.` });
                if (guild) {
                  await logAction(guild, '⚠️ Token Upload Failed', `**${ticket.game.name}** — zip ${zipMB.toFixed(1)} MB > Discord limit ${limitMB} MB. Litterbox upload error:\n\`\`\`\n${(ue?.message || String(ue)).slice(0, 500)}\n\`\`\``, 0xED4245);
                }
                try { fsMod.unlinkSync(zipPath); } catch {}
                return;
              }

              // Success: post the link instead of attaching the file
              const filenameNote = upload.provider === 'gofile'
                ? `The link opens a download page — click the **Download** button on that page to save **\`Token [${safeGameName}].zip\`** (filename is preserved).`
                : `The link is a direct download. The file will arrive named with a random hash — **rename it to \`Token [${safeGameName}].zip\`** before extracting if you want it organized (the zip contents are correct either way).`;

              const linkEmbed = new EmbedBuilder()
                .setTitle(`📦 ${CONFIG.NAME} • Token Delivery (External)`)
                .setDescription(
                  `<@${ticket.userId}>, your activation token for **${ticket.game.name}** is ready!\n\n` +
                  `The zip was too large for Discord (${zipMB.toFixed(1)} MB), so it's been uploaded to a file host.\n\n` +
                  `**[⬇️ Download Token Zip](${upload.url})** *(${zipMB.toFixed(1)} MB)*\n\n` +
                  filenameNote + `\n\n` +
                  `━━━━━━━━━━━━━━━━━━━━━━\n` +
                  `⚠️ **CRITICAL INSTRUCTIONS**\n` +
                  `1. Download the zip from the link above.\n` +
                  `2. Extract it into your game folder.\n` +
                  `3. **NEVER** launch the game from Steam.\n` +
                  `4. Always use the **.exe** located in your game folder.\n` +
                  `━━━━━━━━━━━━━━━━━━━━━━\n` +
                  `⏱️ ${upload.expiryText}.`
                )
                .addFields(
                  { name: '👤 Requester', value: `<@${ticket.userId}>`, inline: true },
                  { name: '🛠️ Activator', value: `${client.user}`, inline: true },
                  { name: '📋 Next Step', value: 'Confirm using the buttons below once installed.', inline: false }
                )
                .setColor(0x5865F2)
                .setTimestamp();

              const worksRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('works_yes').setLabel('Yes, it works!').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('works_no').setLabel('No, it doesn\'t work').setStyle(ButtonStyle.Danger)
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

              if (guild) {
                await logAction(guild, '🤖 Auto-Token Delivered (External Host)', `Bot auto-generated and delivered token for **${ticket.game.name}** (${zipMB.toFixed(1)} MB) via ${upload.provider} in <#${message.channelId}>. Link: ${upload.url}`, 0x57F287);
              }

              // Clean up local zip — we have the hosted copy
              try { fsMod.unlinkSync(zipPath); } catch {}
              return;
            }

            const zipFile = new AttachmentBuilder(zipPath, { name: `Token [${safeGameName}].zip` });
            const deliveryEmbed = createTokenDeliveryEmbed(ticket.game.name, ticket.userId, client.user!);

            const worksRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId('works_yes').setLabel('Yes, it works!').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId('works_no').setLabel('No, it doesn\'t work').setStyle(ButtonStyle.Danger)
            );

            const deliveryMsg = await (message.channel as TextChannel).send({
              embeds: [deliveryEmbed],
              files: [zipFile],
              components: [worksRow]
            });

            await prisma.ticket.update({
              where: { id: ticket.id },
              data: { deliveryMessageId: deliveryMsg.id, staffId: client.user!.id }
            });

            await genMsg.delete().catch(() => {});
            await deliveryMsg.react('❤️').catch(() => {});

            if (guild) {
              await logAction(guild, '🤖 Auto-Token Delivered', `Bot auto-generated and delivered token for **${ticket.game.name}** (AppID: \`${appId}\`) in <#${message.channelId}>.`, 0x57F287);
            }
          } else {
            const failEmbed = new EmbedBuilder()
              .setTitle('⚠️ Auto-Generation Failed')
              .setDescription(`Could not auto-generate token for **${ticket.game.name}**.\nA staff member will need to handle this manually.\n\n\'\'\'\n${logs.slice(-300)}\n\'\'\'`)
              .setColor(0xED4245)
              .setTimestamp();
            await genMsg.edit({ embeds: [failEmbed] });

            // Ping staff for manual handling
            await (message.channel as TextChannel).send({ content: `<@&${CONFIG.STAFF_ROLE_ID}> Auto-generation failed. Manual token delivery needed.` });
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
            .setDescription(`Token generation encountered an error. Staff has been notified.\n\`\`\`\n${detail.slice(0, 500)}\n\`\`\`${hint}`)
            .setColor(0xED4245);
          await genMsg.edit({ embeds: [errEmbed] });
          await (message.channel as TextChannel).send({ content: `<@&${CONFIG.STAFF_ROLE_ID}> Auto-generation error. Please handle manually.` });

          // Also log to staff log channel
          try {
            if (guild) {
              await logAction(guild, '🚨 Token Generation Error', `User <@${ticket.userId}> hit a token-gen error for **${ticket.game.name}** (AppID \`${ticket.game.appId}\`):\n\`\`\`\n${detail.slice(0, 800)}\n\`\`\`${hint}`, 0xED4245);
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
          
          const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
          if (guild) {
            await logAction(guild, '❌ Screenshot Rejected', `User <@${message.author.id}> provided an invalid screenshot for **${ticket.game.name}**.\n\n**Reasoning:** ${reasoning || 'No details'}\n**Attempts:** \`${newRetryCount}/3\``, 0xED4245);
          }
          
          const newTimer = setTimeout(async () => {
            const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
            if (guild) {
              await autoCloseTicketForVerificationTimeout(message.channelId, guild);
            }
          }, 10 * 60 * 1000);
          pendingVerificationTimers.set(message.channelId, newTimer);
        }
      }

    }
  }

  // --- NEW: Staff Delivery Detection ---
  const firstAttachment = message.attachments.first();
  if (firstAttachment && firstAttachment.name.toLowerCase().endsWith('.zip') && message.member?.roles.cache.has(CONFIG.STAFF_ROLE_ID)) {
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
             new ButtonBuilder().setCustomId('works_yes').setLabel('Yes, it works!').setStyle(ButtonStyle.Success),
             new ButtonBuilder().setCustomId('works_no').setLabel('No, it doesn\'t work').setStyle(ButtonStyle.Danger)
          );

          const deliveryMsg = await message.channel.send({
            embeds: [deliveryEmbed],
            components: [worksRow]
          });
          
          await prisma.ticket.update({
            where: { id: ticket.id },
            data: { deliveryMessageId: deliveryMsg.id }
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
  if (message.channelId === CONFIG.VOUCHER_CHANNEL_ID) {
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
            `*This reminder will disappear in 15 seconds.*`
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
          if (reminder) setTimeout(() => reminder.delete().catch(() => {}), 15000);
        }

        return;
      }

      // Bot reacts to confirm it detected the vouch
      await message.react('❤️').catch(() => {});

      // ─── FAST-PATH AUTO-CLOSE ───
      // If the user pings the bot AND attaches a screenshot, finalize immediately:
      //   • 24h cooldown
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

          // 24h cooldown
          const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
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
              .setDescription(`Vouch + screenshot detected. Session closed.\n\n**Cooldown:** \`24h\`\n**Token Deducted:** \`YES\``)
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
              `Bot auto-closed session for <@${ticket.userId}> after vouch (ping + screenshot) in <#${CONFIG.VOUCHER_CHANNEL_ID}>.\n\n**Game:** ${ticket.game.name}\n**Cooldown:** \`24h\`\n**Token Deducted:** \`YES\``,
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
    if (message.channelId !== CONFIG.VOUCHER_CHANNEL_ID) return;

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

        const until = new Date();
        until.setTime(until.getTime() + (24 * 60 * 60 * 1000));
        await prisma.cooldown.upsert({ where: { userId: ticket.userId }, update: { until }, create: { userId: ticket.userId, until } });

        await prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'CLOSED', closedAt: new Date(), vouchExpiresAt: null } });

        const channel = await client.channels.fetch(ticket.channelId).catch(() => null) as TextChannel;
        if (channel) {
          const successEmbed = new EmbedBuilder()
            .setTitle('✅ Vouch Verified')
            .setDescription(`Vouch confirmed by **${user.id === client.user?.id ? 'System' : user.username}**. Session closed with 24h bonus cooldown.`)
            .setColor(0x57F287)
            .setTimestamp();
          await channel.send({ embeds: [successEmbed] });
          setTimeout(() => channel.delete().catch(() => {}), 5000);
        }

        const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
        if (guild) {
          await logAction(guild, '✅ Vouch Verified (Reaction)', `Vouch for <@${ticket.userId}> confirmed by <@${user.id}> via '❤️' reaction. Ticket closed.`, 0x57F287);
        }
        await refreshAllPanels();
      }
    }
  } catch (err) {
    console.error('Error in MessageReactionAdd:', err);
  }
});

async function postMainPanel(channel: TextBasedChannel) {
  if (channel.isTextBased() && 'send' in channel) {
    const panel = await createMainPanel();
    const coverPath = path.join(__dirname, 'public/gamegen.png');
    const cover = new AttachmentBuilder(coverPath, { name: 'gamegen.png' });
    
    const sentMessage = await (channel as TextChannel).send({
      ...panel,
      files: [cover]
    });
    
    await prisma.panel.create({
      data: { channelId: channel.id, messageId: sentMessage.id }
    }).catch(() => {});
  }
}

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

async function resumeFromMaintenance(channelId: string, messageId?: string) {
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null) as TextBasedChannel | null;
    if (channel) {
      if (messageId && 'messages' in channel) {
        const msg = await (channel as TextChannel).messages.fetch(messageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      }
      
      await postMainPanel(channel);
      
      const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
      if (guild) {
        await logAction(guild, '🔄 System Resumed', `Maintenance ended in <#${channelId}>. Panel has been restored.`, 0x5865F2);
      }
    }
    // Cleanup DB
    await prisma.maintenance.deleteMany({ where: { channelId } });
  } catch (err) {
    console.error(`Failed to resume from maintenance in ${channelId}:`, err);
  }
}



// --- Background Cycles ---
setInterval(() => updateTicketWaitTimes(client), 60 * 1000); // Live Wait Updates (Every 1m)
setInterval(() => checkWeeklyStaffStats(client), 15 * 60 * 1000); // Weekly Check (Every 15m for precision)
setInterval(() => checkDutyStatusReset(), 30 * 60 * 1000); // Duty Reset (Every 30m)
setInterval(() => checkStaleTickets(client), 10 * 60 * 1000); // Stale Tickets (Every 10m)
setInterval(() => cleanupExpiredCooldowns(), 6 * 60 * 60 * 1000); // Bug #15: Cooldown Cleanup (Every 6h)

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
