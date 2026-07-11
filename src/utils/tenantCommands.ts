/**
 * tenantCommands.ts — owner-only tenant management + buyer setup commands
 * (/setlogs, /setvouch, /addsupport).
 *
 * index.ts imports the command builders (to register), OWNER_COMMAND_NAMES
 * (to filter buyer guilds), and handleTenantCommand() (the router).
 */

import {
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
  EmbedBuilder,
  GuildMember,
} from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { invalidateTenantCache, getAllTenants } from './tenant';
import { getPoolStatus, linkPoolAccountGame, unlinkPoolAccountGame, linkAllCatalogGamesToAccount, listPoolAccountGames } from './steampassPool';
import { logAction } from './logging';

export const OWNER_COMMANDS = [
  new SlashCommandBuilder()
    .setName('addserver')
    .setDescription('[OWNER] Authorize a buyer server + set its steampass account')
    .addStringOption(o => o.setName('guildid').setDescription('The buyer server (guild) ID').setRequired(true))
    .addStringOption(o => o.setName('name').setDescription('Server name (for your reference)').setRequired(true))
    .addStringOption(o => o.setName('steampass_email').setDescription('Their steampass.gg email').setRequired(true))
    .addStringOption(o => o.setName('steampass_password').setDescription('Their steampass.gg password').setRequired(true))
    .addStringOption(o => o.setName('link').setDescription('Invite link (optional)').setRequired(false))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('configserver')
    .setDescription('[OWNER] Set a per-server field for a buyer server')
    .addStringOption(o => o.setName('guildid').setDescription('The buyer server (guild) ID').setRequired(true))
    .addStringOption(o => o.setName('field').setDescription('Which field to set').setRequired(true).addChoices(
      { name: 'staff role id', value: 'staffRoleId' },
      { name: 'activators role id', value: 'activatorsRoleId' },
      { name: 'ticket category id', value: 'ticketCategoryId' },
      { name: 'voucher channel id', value: 'voucherChannelId' },
      { name: 'stock-notify channel id', value: 'stockNotifChannelId' },
      { name: 'log channel id', value: 'logChannelId' },
      { name: 'donator role id', value: 'donatorRoleId' },
      { name: 'bronze role id', value: 'bronzeRoleId' },
      { name: 'silver role id', value: 'silverRoleId' },
      { name: 'gold role id', value: 'goldRoleId' },
      { name: 'bot name', value: 'botName' },
      { name: 'patreon url', value: 'patreonUrl' },
      { name: 'steampass email', value: 'steampassLogin' },
      { name: 'steampass password', value: 'steampassPassword' },
      { name: 'server name', value: 'serverName' },
      { name: 'invite link', value: 'inviteLink' },
    ))
    .addStringOption(o => o.setName('value').setDescription('The value to set (blank to clear)').setRequired(false))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('removeserver')
    .setDescription('[OWNER] Remove a buyer server entirely (bot will leave it)')
    .addStringOption(o => o.setName('guildid').setDescription('The buyer server (guild) ID').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('pauseserver')
    .setDescription('[OWNER] Suspend a buyer server (non-payment) WITHOUT leaving it')
    .addStringOption(o => o.setName('guildid').setDescription('The buyer server (guild) ID').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('resumeserver')
    .setDescription('[OWNER] Un-suspend a previously paused buyer server')
    .addStringOption(o => o.setName('guildid').setDescription('The buyer server (guild) ID').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('listservers')
    .setDescription('[OWNER] List all buyer servers + their steampass accounts')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('viewserver')
    .setDescription('[OWNER] View full config for a specific buyer server')
    .addStringOption(o => o.setName('guildid').setDescription('The buyer server (guild) ID').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('steampass')
    .setDescription('[OWNER] Manage the multi-account steampass pool')
    .addSubcommand(s => s.setName('add').setDescription('Add an account to the pool')
      .addStringOption(o => o.setName('email').setDescription('steampass email').setRequired(true))
      .addStringOption(o => o.setName('password').setDescription('steampass password').setRequired(true))
      .addStringOption(o => o.setName('label').setDescription('label (optional)').setRequired(false)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove an account from the pool')
      .addStringOption(o => o.setName('email').setDescription('steampass email to remove').setRequired(true)))
    .addSubcommand(s => s.setName('linkgame').setDescription('Link a pool account to a game (+5 stock for that game)')
      .addStringOption(o => o.setName('email').setDescription('Pool account email').setRequired(true))
      .addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('unlinkgame').setDescription('Remove a game from a pool account')
      .addStringOption(o => o.setName('email').setDescription('Pool account email').setRequired(true))
      .addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('linkall').setDescription('Link ALL catalog games to an account (only if it truly owns everything)')
      .addStringOption(o => o.setName('email').setDescription('Pool account email').setRequired(true)))
    .addSubcommand(s => s.setName('games').setDescription('List games linked to a pool account')
      .addStringOption(o => o.setName('email').setDescription('Pool account email').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('Show pool accounts + today usage'))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
];

export const SETLOGS_COMMAND = new SlashCommandBuilder()
  .setName('setlogs')
  .setDescription('Set this server basic log channel')
  .addChannelOption(o => o.setName('channel').setDescription('Channel for basic logs').setRequired(true))
  .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator);

export const SETVOUCH_COMMAND = new SlashCommandBuilder()
  .setName('setvouch')
  .setDescription('Set this server vouch channel')
  .addChannelOption(o => o.setName('channel').setDescription('Channel where users post their vouches').setRequired(true))
  .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator);

export const ADDSUPPORT_COMMAND = new SlashCommandBuilder()
  .setName('addsupport')
  .setDescription('Set this server support/staff role (pinged when staff help is needed)')
  .addRoleOption(o => o.setName('role').setDescription('Your staff/support role').setRequired(true))
  .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator);

export const OWNER_COMMAND_NAMES = new Set([
  'addserver', 'configserver', 'removeserver', 'pauseserver',
  'resumeserver', 'listservers', 'viewserver', 'steampass',
]);

export function isOwnerInteraction(interaction: any): boolean {
  if (interaction.guildId !== CONFIG.OWNER_GUILD_ID) return false;
  const m = interaction.member as GuildMember | null;
  const hasRole = !!m?.roles?.cache?.has?.(CONFIG.OWNER_ROLE_ID);
  const hasAdmin = !!m?.permissions?.has?.(PermissionsBitField.Flags.Administrator);
  return hasRole || hasAdmin;
}

export async function handleTenantCommand(interaction: any): Promise<boolean> {
  const name = interaction.commandName;

  if (name === 'setlogs') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const channel = interaction.options.getChannel('channel');
    if (interaction.guildId === CONFIG.OWNER_GUILD_ID) {
      await interaction.editReply({ content: 'ℹ️ This is the owner server — detailed logs go to the home channel.' });
      return true;
    }
    try {
      await (prisma as any).tenantServer.update({
        where: { guildId: interaction.guildId },
        data: { logChannelId: channel.id },
      });
      invalidateTenantCache();
      await interaction.editReply({ content: `✅ Basic logs for this server will now post to <#${channel.id}>.` });
    } catch (e) {
      await interaction.editReply({ content: `❌ This server isn't provisioned, or the update failed: ${(e as Error).message}` });
    }
    return true;
  }

  if (name === 'setvouch') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const channel = interaction.options.getChannel('channel');
    if (interaction.guildId === CONFIG.OWNER_GUILD_ID) {
      await interaction.editReply({ content: 'ℹ️ This is the owner server — it uses the global config for vouches.' });
      return true;
    }
    try {
      await (prisma as any).tenantServer.update({
        where: { guildId: interaction.guildId },
        data: { voucherChannelId: channel.id },
      });
      invalidateTenantCache();
      await interaction.editReply({ content: `✅ Vouches for this server will now be monitored in <#${channel.id}>.` });
    } catch (e) {
      await interaction.editReply({ content: `❌ This server isn't provisioned, or the update failed: ${(e as Error).message}` });
    }
    return true;
  }

  if (name === 'addsupport') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const role = interaction.options.getRole('role');
    if (interaction.guildId === CONFIG.OWNER_GUILD_ID) {
      await interaction.editReply({ content: 'ℹ️ This is the owner server — it uses the global config for support.' });
      return true;
    }
    try {
      const existing = await (prisma as any).tenantServer.findUnique({ where: { guildId: interaction.guildId } });
      const oldRole = existing?.staffRoleId;
      await (prisma as any).tenantServer.update({
        where: { guildId: interaction.guildId },
        data: { staffRoleId: role.id, activatorsRoleId: role.id },
      });
      invalidateTenantCache();
      const note = oldRole && oldRole !== role.id ? `\n*(Replaced previous role <@&${oldRole}>)*` : '';
      await interaction.editReply({ content: `✅ Support role set to <@&${role.id}>. It'll be pinged when staff help is needed and given access to ticket channels.${note}` });
    } catch (e) {
      await interaction.editReply({ content: `❌ This server isn't provisioned, or the update failed: ${(e as Error).message}` });
    }
    return true;
  }

  if (!OWNER_COMMAND_NAMES.has(name)) return false;

  if (!isOwnerInteraction(interaction)) {
    await interaction.reply({ content: '❌ **Owner only.**', flags: [MessageFlags.Ephemeral] }).catch(() => {});
    return true;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    if (name === 'addserver') {
      const guildId = interaction.options.getString('guildid', true).trim();
      const serverName = interaction.options.getString('name', true).trim();
      const steampassLogin = interaction.options.getString('steampass_email', true).trim();
      const steampassPassword = interaction.options.getString('steampass_password', true);
      const inviteLink = interaction.options.getString('link')?.trim() || null;
      await (prisma as any).tenantServer.upsert({
        where: { guildId },
        update: { serverName, steampassLogin, steampassPassword, inviteLink, active: true },
        create: { guildId, serverName, steampassLogin, steampassPassword, inviteLink, active: true },
      });
      invalidateTenantCache();
      await logAction(interaction.guild, '🟢 Tenant Added', `Owner ${interaction.user} provisioned server \`${guildId}\`.`, 0x57F287);
      await interaction.editReply({ content: `✅ **${serverName}** (\`${guildId}\`) is now an active tenant.\nSet its roles/channels with \`/configserver\`, or its admins can run \`/setlogs\`, \`/setvouch\`, \`/addsupport\`.` });
      return true;
    }

    if (name === 'configserver') {
      const guildId = interaction.options.getString('guildid', true).trim();
      const field = interaction.options.getString('field', true);
      const value = interaction.options.getString('value')?.trim() || null;
      const idFields = ['staffRoleId', 'activatorsRoleId', 'ticketCategoryId', 'voucherChannelId', 'stockNotifChannelId', 'logChannelId', 'donatorRoleId', 'bronzeRoleId', 'silverRoleId', 'goldRoleId'];
      if (value && idFields.includes(field) && !/^\d{17,20}$/.test(value)) {
        await interaction.editReply({ content: `❌ \`${field}\` expects a Discord snowflake ID (17-20 digit number), got \`${value}\`.` });
        return true;
      }
      await (prisma as any).tenantServer.update({ where: { guildId }, data: { [field]: value } });
      invalidateTenantCache();
      const shown = (field === 'steampassPassword') ? '••••••' : (value ?? '(cleared)');
      await interaction.editReply({ content: `✅ Set \`${field}\` = \`${shown}\` for \`${guildId}\`.` });
      return true;
    }

    if (name === 'removeserver') {
      const guildId = interaction.options.getString('guildid', true).trim();
      const tenant = await (prisma as any).tenantServer.findUnique({ where: { guildId } }).catch(() => null);
      if (!tenant) {
        await interaction.editReply({ content: `❌ No tenant found for \`${guildId}\`.` });
        return true;
      }
      await (prisma as any).tenantServer.delete({ where: { guildId } });
      invalidateTenantCache();
      const g = interaction.client.guilds.cache.get(guildId);
      if (g) await g.leave().catch(() => {});
      await logAction(interaction.guild, '🗑️ Tenant Removed', `Owner ${interaction.user} removed server **${tenant.serverName}** (\`${guildId}\`).`, 0xED4245);
      await interaction.editReply({ content: `🗑️ Removed **${tenant.serverName}** (\`${guildId}\`) and left the server (if present).` });
      return true;
    }

    if (name === 'pauseserver' || name === 'resumeserver') {
      const guildId = interaction.options.getString('guildid', true).trim();
      const active = name === 'resumeserver';
      await (prisma as any).tenantServer.update({ where: { guildId }, data: { active } });
      invalidateTenantCache();
      await interaction.editReply({
        content: active
          ? `🟢 Resumed \`${guildId}\`.`
          : `⏸️ Paused \`${guildId}\`. The bot STAYS in the server but refuses to operate until \`/resumeserver\`.`,
      });
      return true;
    }

    if (name === 'listservers') {
      const tenants = await getAllTenants();
      if (!tenants.length) { await interaction.editReply({ content: 'No buyer servers provisioned.' }); return true; }
      const lines = tenants.map(t =>
        `${t.active ? '🟢' : '⏸️'} **${t.serverName}** \`${t.guildId}\`\n` +
        `   steampass: \`${t.steampassLogin}\` ${t.logChannelId ? `· logs <#${t.logChannelId}>` : '· no log channel'}`
      ).join('\n');
      const embed = new EmbedBuilder().setTitle('🗂️ Buyer Servers').setDescription(lines.slice(0, 4000)).setColor(0x5865F2);
      await interaction.editReply({ embeds: [embed] });
      return true;
    }

    if (name === 'viewserver') {
      const guildId = interaction.options.getString('guildid', true).trim();
      const tenant = await (prisma as any).tenantServer.findUnique({ where: { guildId } });
      if (!tenant) { await interaction.editReply({ content: `❌ No tenant found for \`${guildId}\`.` }); return true; }
      const fields: string[] = [
        `**Status:** ${tenant.active ? '🟢 Active' : '⏸️ Paused'}`,
        `**Name:** ${tenant.serverName}`,
        `**Guild ID:** \`${tenant.guildId}\``,
        `**Steampass:** \`${tenant.steampassLogin}\``,
        tenant.staffRoleId ? `**Staff Role:** <@&${tenant.staffRoleId}>` : '**Staff Role:** *(not set)*',
        tenant.activatorsRoleId ? `**Activators Role:** <@&${tenant.activatorsRoleId}>` : '**Activators Role:** *(not set)*',
        tenant.ticketCategoryId ? `**Ticket Category:** \`${tenant.ticketCategoryId}\`` : '**Ticket Category:** *(not set)*',
        tenant.voucherChannelId ? `**Vouch Channel:** <#${tenant.voucherChannelId}>` : '**Vouch Channel:** *(not set)*',
        tenant.logChannelId ? `**Log Channel:** <#${tenant.logChannelId}>` : '**Log Channel:** *(not set)*',
        tenant.stockNotifChannelId ? `**Stock Notif Channel:** <#${tenant.stockNotifChannelId}>` : '**Stock Notif:** *(not set)*',
        tenant.donatorRoleId ? `**Donator Role:** <@&${tenant.donatorRoleId}>` : '**Donator Role:** *(not set)*',
        tenant.inviteLink ? `**Invite:** ${tenant.inviteLink}` : '**Invite:** *(not set)*',
      ];
      const embed = new EmbedBuilder()
        .setTitle(`🔍 Server: ${tenant.serverName}`)
        .setDescription(fields.join('\n'))
        .setColor(0x5865F2);
      await interaction.editReply({ embeds: [embed] });
      return true;
    }

    if (name === 'steampass') {
      const sub = interaction.options.getSubcommand();
      const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;

      if (sub === 'add') {
        const email = interaction.options.getString('email', true).trim();
        const password = interaction.options.getString('password', true).trim();
        const label = interaction.options.getString('label')?.trim() || null;
        await (prisma as any).steampassAccount.upsert({
          where: { login: email },
          update: { password, label, active: true },
          create: { login: email, password, label, active: true },
        });
        await interaction.editReply({
          content:
            `✅ Added/updated pool account \`${email}\`.\n\n` +
            `Link the games this account owns with \`/steampass linkgame\` — each linked game gets **+${cap}** stock/day from this account.\n` +
            `Or \`/steampass linkall\` if it owns every game in the catalog.`,
        });
        return true;
      }

      if (sub === 'remove') {
        const email = interaction.options.getString('email', true).trim();
        const exists = await (prisma as any).steampassAccount.findUnique({ where: { login: email } });
        if (!exists) {
          await interaction.editReply({ content: `❌ No pool account found for \`${email}\`.` });
          return true;
        }
        await (prisma as any).steampassAccount.delete({ where: { login: email } });
        const { syncAllOwnerGameStock } = await import('./accountCapacity');
        const synced = await syncAllOwnerGameStock();
        await interaction.editReply({
          content: `🗑️ Removed pool account \`${email}\`. Resynced stock for **${synced}** game(s).`,
        });
        const { refreshAllPanels } = await import('./panelManager');
        refreshAllPanels();
        return true;
      }

      if (sub === 'linkgame') {
        const email = interaction.options.getString('email', true).trim();
        const gameName = interaction.options.getString('game', true).trim();
        const acct = await (prisma as any).steampassAccount.findUnique({ where: { login: email } });
        if (!acct) {
          await interaction.editReply({ content: `❌ No pool account \`${email}\`. Add it first with \`/steampass add\`.` });
          return true;
        }
        const game = await prisma.game.findUnique({ where: { name: gameName, disabled: false } });
        if (!game?.appId) {
          await interaction.editReply({ content: `❌ Game **${gameName}** not found or has no AppID.` });
          return true;
        }
        await linkPoolAccountGame(acct.id, game.appId);
        const { syncStockForGame, countAccountSourcesForApp } = await import('./accountCapacity');
        const remaining = await syncStockForGame(game.id, CONFIG.OWNER_GUILD_ID);
        const acctCount = await countAccountSourcesForApp(game.appId);
        const { refreshAllPanels } = await import('./panelManager');
        refreshAllPanels();
        await interaction.editReply({
          content:
            `✅ Linked \`${email}\` → **${game.name}** (AppID \`${game.appId}\`).\n` +
            `**${acctCount}** account(s) cover this game → **${remaining}** token(s) remaining today (${acctCount * cap} max/day).`,
        });
        return true;
      }

      if (sub === 'unlinkgame') {
        const email = interaction.options.getString('email', true).trim();
        const gameName = interaction.options.getString('game', true).trim();
        const acct = await (prisma as any).steampassAccount.findUnique({ where: { login: email } });
        if (!acct) {
          await interaction.editReply({ content: `❌ No pool account \`${email}\`.` });
          return true;
        }
        const game = await prisma.game.findUnique({ where: { name: gameName } });
        if (!game?.appId) {
          await interaction.editReply({ content: `❌ Game **${gameName}** not found.` });
          return true;
        }
        await unlinkPoolAccountGame(acct.id, game.appId);
        const { syncStockForGame } = await import('./accountCapacity');
        const remaining = await syncStockForGame(game.id, CONFIG.OWNER_GUILD_ID);
        const { refreshAllPanels } = await import('./panelManager');
        refreshAllPanels();
        await interaction.editReply({
          content: `🗑️ Unlinked \`${email}\` from **${game.name}**. Stock is now **${remaining}** for that game.`,
        });
        return true;
      }

      if (sub === 'linkall') {
        const email = interaction.options.getString('email', true).trim();
        const acct = await (prisma as any).steampassAccount.findUnique({ where: { login: email } });
        if (!acct) {
          await interaction.editReply({ content: `❌ No pool account \`${email}\`.` });
          return true;
        }
        const linked = await linkAllCatalogGamesToAccount(acct.id);
        const { syncAllOwnerGameStock } = await import('./accountCapacity');
        await syncAllOwnerGameStock();
        const { refreshAllPanels } = await import('./panelManager');
        refreshAllPanels();
        await interaction.editReply({
          content:
            `✅ Linked **${linked}** catalog game(s) to \`${email}\` (+${cap} stock/day each from this account).\n` +
            `Only use this if the account truly owns every game.`,
        });
        return true;
      }

      if (sub === 'games') {
        const email = interaction.options.getString('email', true).trim();
        const acct = await (prisma as any).steampassAccount.findUnique({ where: { login: email } });
        if (!acct) {
          await interaction.editReply({ content: `❌ No pool account \`${email}\`.` });
          return true;
        }
        const appIds = await listPoolAccountGames(acct.id);
        if (appIds.length === 0) {
          await interaction.editReply({
            content: `📭 \`${email}\` has no games linked yet. Use \`/steampass linkgame\` or \`/steampass linkall\`.`,
          });
          return true;
        }
        const games = await prisma.game.findMany({ where: { appId: { in: appIds } }, orderBy: { name: 'asc' } });
        const nameByApp = new Map(games.map(g => [g.appId, g.name]));
        const lines = appIds.map(id => `• **${nameByApp.get(id) || `AppID ${id}`}** (\`${id}\`) — ${cap}/day`).join('\n');
        await interaction.editReply({
          content: `🎮 **${appIds.length}** game(s) linked to \`${email}\`:\n${lines}`,
        });
        return true;
      }

      if (sub === 'list') {
        const status = await getPoolStatus();
        if (!status.length) {
          await interaction.editReply({ content: 'Pool is empty. Add accounts with `/steampass add`, then link games with `/steampass linkgame`.' });
          return true;
        }
        const lines = status.map(a =>
          `${a.active ? '🟢' : '⏸️'} \`#${a.id}\` \`${a.login}\`${a.label ? ` (${a.label})` : ''}\n` +
          `╰─ **${a.gameCount}** game(s) linked · **${a.usedToday}** tokens used today · ${a.hasToken ? '🔑 bearer cached' : '⚠️ no bearer'}`
        ).join('\n\n');
        const embed = new EmbedBuilder()
          .setTitle('🔑 Steampass Pool')
          .setDescription(lines.slice(0, 4000))
          .setFooter({ text: `Each linked game = +${cap} stock/day per account · /steampass linkgame to assign` })
          .setColor(0x5865F2);
        await interaction.editReply({ embeds: [embed] });
        return true;
      }
    }
  } catch (e) {
    await interaction.editReply({ content: `❌ Error: ${(e as Error).message}` }).catch(() => {});
    return true;
  }

  return true;
}