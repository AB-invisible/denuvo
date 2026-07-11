import { EmbedBuilder } from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { utcDateKey } from '../utils/steampassPool';
import { logAction } from '../utils/logging';

/**
 * /ubisoftaccount — owner-only management of BYO Ubisoft accounts used to
 * mint Denuvo tokens via ubisoft-service. Each account is good for up to the
 * Denuvo daily cap (OWNER_TOKENS_PER_ACCOUNT_PER_DAY) tokens/day; gen rotates
 * to the next account when spent, then to the service's env-default account.
 *
 *   /ubisoftaccount add email:<e> password:<pw> [label]
 *   /ubisoftaccount list
 *   /ubisoftaccount remove id:<row id>
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
      const acct = await (prisma as any).ubisoftAccount.upsert({
        where: { guildId_email: { guildId: '', email } },
        update: { password, label, active: true },
        create: { guildId: '', email, password, label },
      });
      const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
      await interaction.editReply({
        content:
          `✅ **Ubisoft account saved** (#${acct.id}).\n` +
          `• Email: \`${email}\`\n\n` +
          `The bot uses this account to mint Ubisoft tokens — up to \`${cap}\` per day — then rotates to the next account and finally the service's default account. ` +
          `First login may need a trusted device (\`LoginStore.dat\`) seeded on the service.`,
      });
      if (interaction.guild) {
        await logAction(interaction.guild, '🎮 Ubisoft Account Added', `Owner added Ubisoft account \`${email}\` (#${acct.id}).`, 0x57F287);
      }
    } catch (e) {
      return interaction.editReply({ content: `❌ Failed to save account: ${(e as Error).message}` });
    }
    return;
  }

  if (sub === 'remove') {
    const id = interaction.options.getInteger('id', true);
    try {
      const acct = await (prisma as any).ubisoftAccount.findUnique({ where: { id } }).catch(() => null);
      if (!acct) return interaction.editReply({ content: `❌ No Ubisoft account with ID \`${id}\`.` });
      await (prisma as any).ubisoftAccount.delete({ where: { id } });
      await interaction.editReply({ content: `🗑️ Removed Ubisoft account #${id} (\`${acct.email}\`).` });
      if (interaction.guild) {
        await logAction(interaction.guild, '🗑️ Ubisoft Account Removed', `Owner removed Ubisoft account \`${acct.email}\` (#${id}).`, 0xFEE75C);
      }
    } catch (e) {
      return interaction.editReply({ content: `❌ Failed to remove: ${(e as Error).message}` });
    }
    return;
  }

  // ── list ──
  let accounts: any[] = [];
  try {
    accounts = await (prisma as any).ubisoftAccount.findMany({ orderBy: [{ priority: 'asc' }, { id: 'asc' }] });
  } catch (e) {
    return interaction.editReply({ content: `❌ Failed to read accounts: ${(e as Error).message}` });
  }
  if (accounts.length === 0) {
    return interaction.editReply({ content: '📭 No Ubisoft accounts registered yet. Add one with `/ubisoftaccount add`.' });
  }

  const today = utcDateKey();
  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;

  let lines = '';
  for (const a of accounts) {
    let used = 0;
    try {
      const u = await (prisma as any).ubisoftUsage.findUnique({ where: { accountId_usageDate: { accountId: a.id, usageDate: today } } });
      used = u?.count ?? 0;
    } catch { used = 0; }
    const state = a.active ? '' : ' · ⏸️ inactive';
    const fails = a.failureCount ? ` · ⚠️${a.failureCount} fail(s)` : '';
    const lbl = a.label ? ` — ${a.label}` : '';
    lines += `**#${a.id}** \`${a.email}\`${lbl}\n╰─ ${used}/${cap} today${state}${fails}\n`;
  }

  const embed = new EmbedBuilder()
    .setTitle('🎮 Ubisoft Accounts')
    .setDescription(lines)
    .setColor(0x5865F2)
    .setFooter({ text: `Rotated in priority order (${cap}/day each), then the service's default account` })
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}
