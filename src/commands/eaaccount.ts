import { EmbedBuilder } from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { utcDateKey } from '../utils/steampassPool';
import { logAction } from '../utils/logging';

/**
 * /eaaccount — owner-only EA accounts for token minting (auto-login on ea-service).
 *
 *   /eaaccount add email:<e> password:<pw> [label]
 *   /eaaccount list
 *   /eaaccount remove id:<row id>
 */
export async function execute(interaction: any): Promise<void> {
  if (interaction.guildId !== CONFIG.OWNER_GUILD_ID) {
    return interaction.editReply({ content: '❌ This command is only available in the owner server.' });
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const email = interaction.options.getString('email', true).trim();
    const password = interaction.options.getString('password', true);
    const label = (interaction.options.getString('label') || '').trim() || null;

    if (!email || !password) return interaction.editReply({ content: '❌ Email and password are required.' });

    try {
      const acct = await (prisma as any).eaAccount.upsert({
        where: { guildId_email: { guildId: '', email } },
        update: { password, label, active: true },
        create: { guildId: '', email, password, label },
      });
      const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
      await interaction.editReply({
        content:
          `✅ **EA account saved** (#${acct.id}).\n` +
          `• Email: \`${email}\`\n\n` +
          `ea-service will **auto-login** with this account (no manual remid/signature setup). ` +
          `Up to \`${cap}\` tokens/day, then rotates to the next account / service default.\n\n` +
          `⚠️ First login may require a one-time **email verification** from EA — complete it once, then retries work headlessly.`,
      });
      if (interaction.guild) {
        await logAction(interaction.guild, '🎮 EA Account Added', `Owner added EA account \`${email}\` (#${acct.id}).`, 0x57F287);
      }
    } catch (e) {
      return interaction.editReply({ content: `❌ Failed to save account: ${(e as Error).message}` });
    }
    return;
  }

  if (sub === 'remove') {
    const id = interaction.options.getInteger('id', true);
    try {
      const acct = await (prisma as any).eaAccount.findUnique({ where: { id } }).catch(() => null);
      if (!acct) return interaction.editReply({ content: `❌ No EA account with ID \`${id}\`.` });
      await (prisma as any).eaAccount.delete({ where: { id } });
      await interaction.editReply({ content: `🗑️ Removed EA account #${id} (\`${acct.email}\`).` });
      if (interaction.guild) {
        await logAction(interaction.guild, '🗑️ EA Account Removed', `Owner removed EA account \`${acct.email}\` (#${id}).`, 0xFEE75C);
      }
    } catch (e) {
      return interaction.editReply({ content: `❌ Failed to remove: ${(e as Error).message}` });
    }
    return;
  }

  let accounts: any[] = [];
  try {
    accounts = await (prisma as any).eaAccount.findMany({ orderBy: [{ priority: 'asc' }, { id: 'asc' }] });
  } catch (e) {
    return interaction.editReply({ content: `❌ Failed to read accounts: ${(e as Error).message}` });
  }
  if (accounts.length === 0) {
    return interaction.editReply({ content: '📭 No EA accounts registered yet. Add one with `/eaaccount add`.' });
  }

  const today = utcDateKey();
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;

  let lines = '';
  for (const a of accounts) {
    let used = 0;
    try {
      const u = await (prisma as any).eaUsage.findUnique({ where: { accountId_usageDate: { accountId: a.id, usageDate: today } } });
      used = u?.count ?? 0;
    } catch {
      used = 0;
    }
    const state = a.active ? '' : ' · ⏸️ inactive';
    const fails = a.failureCount ? ` · ⚠️${a.failureCount} fail(s)` : '';
    const lbl = a.label ? ` — ${a.label}` : '';
    lines += `**#${a.id}** \`${a.email}\`${lbl}\n╰─ ${used}/${cap} today${state}${fails}\n`;
  }

  const embed = new EmbedBuilder()
    .setTitle('🎮 EA Accounts')
    .setDescription(lines)
    .setColor(0x5865F2)
    .setFooter({ text: `Auto-login on ea-service · ${cap}/day each, then env default` })
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}
