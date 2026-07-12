import { EmbedBuilder } from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { logAction } from '../utils/logging';
import { isUbisoftGame } from '../utils/ubisoftCatalog';
import { getUbisoftGameUsageToday, setUbisoftGameUsageToday } from '../utils/ubisoftUsage';

/**
 * /ubisoftaccount — owner-only management of BYO Ubisoft accounts used to
 * mint Denuvo tokens via ubisoft-service. Each account is good for up to the
 * Denuvo daily cap (OWNER_TOKENS_PER_ACCOUNT_PER_DAY) tokens **per title** per day;
 * gen rotates to the next account when spent, then to the service's env-default account.
 *
 *   /ubisoftaccount add email:<e> password:<pw> [label]
 *   /ubisoftaccount list
 *   /ubisoftaccount markfull id:<row id>  — set today's usage to cap (5/5)
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
          `The bot uses this account to mint Ubisoft tokens — up to \`${cap}\` **per title per day** — then rotates to the next account and finally the service's default account. ` +
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

  if (sub === 'markfull') {
    const id = interaction.options.getInteger('id', true);
    const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
    try {
      const acct = await (prisma as any).ubisoftAccount.findUnique({ where: { id } }).catch(() => null);
      if (!acct) return interaction.editReply({ content: `❌ No Ubisoft account with ID \`${id}\`.` });
      const games = await prisma.game.findMany({
        where: { disabled: false },
        select: { name: true, ubisoftAppId: true },
      });
      const titles = games.filter((g) => isUbisoftGame(g) && g.ubisoftAppId);
      for (const g of titles) {
        await setUbisoftGameUsageToday(id, g.ubisoftAppId!, cap);
      }
      const { refreshAllPanels } = await import('../utils/panelManager');
      await refreshAllPanels();
      await interaction.editReply({
        content:
          `✅ Marked **#${id}** \`${acct.email}\` as **${cap}/${cap}** used today on **${titles.length}** Ubisoft title(s). Panel refreshed.`,
      });
    } catch (e) {
      return interaction.editReply({ content: `❌ Failed: ${(e as Error).message}` });
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
  const { reconcileOrphanEnvUsage } = await import('../utils/accountCapacity');
  const merged = await reconcileOrphanEnvUsage('ubisoft', 0);

  let accounts: any[] = [];
  try {
    accounts = await (prisma as any).ubisoftAccount.findMany({ orderBy: [{ priority: 'asc' }, { id: 'asc' }] });
  } catch (e) {
    return interaction.editReply({ content: `❌ Failed to read accounts: ${(e as Error).message}` });
  }
  if (accounts.length === 0) {
    return interaction.editReply({ content: '📭 No Ubisoft accounts registered yet. Add one with `/ubisoftaccount add`.' });
  }

  const cap = CONFIG.OWNER_TOKENS_PER_ACCOUNT_PER_DAY;
  const games = await prisma.game.findMany({
    where: { disabled: false },
    select: { name: true, ubisoftAppId: true },
    orderBy: { name: 'asc' },
  });
  const titles = games.filter((g) => isUbisoftGame(g) && g.ubisoftAppId);

  let lines = '';
  for (const a of accounts) {
    const state = a.active ? '' : ' · ⏸️ inactive';
    const fails = a.failureCount ? ` · ⚠️${a.failureCount} fail(s)` : '';
    const lbl = a.label ? ` — ${a.label}` : '';
    lines += `**#${a.id}** \`${a.email}\`${lbl}${state}${fails}\n`;
    if (titles.length === 0) {
      lines += `╰─ ${cap}/day per title (no Ubisoft games in catalog yet)\n`;
    } else {
      for (const g of titles) {
        const used = await getUbisoftGameUsageToday(a.id, g.ubisoftAppId!);
        lines += `╰─ **${g.name}:** ${used}/${cap}\n`;
      }
    }
  }

  const embed = new EmbedBuilder()
    .setTitle('🎮 Ubisoft Accounts')
    .setDescription(lines)
    .setColor(0x5865F2)
    .setFooter({
      text:
        `${cap}/day per title · rotated in priority order, then the service default account` +
        (merged > 0 ? ` · merged ${merged} legacy env use(s)` : ''),
    })
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}
