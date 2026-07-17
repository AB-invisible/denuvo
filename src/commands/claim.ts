import { EmbedBuilder } from 'discord.js';
import prisma from '../lib/prisma';
import { CONFIG } from '../config';
import { logAction } from '../utils/logging';
import { getOrCreateServerStock } from '../utils/gameManager';

/**
 * /claim — Patreon monthly bypass reservation for high-demand games.
 *
 * Flow:
 *   1. Verify the user is an active Patreon patron (PatreonMember with
 *      matching discordId + patronStatus='active_patron').
 *   2. The game must exist, be enabled, and be marked highDemand.
 *   3. User hasn't used their monthly claim for this game yet (UTC month).
 *   4. Game must be OUT OF STOCK — if in stock, tell them to just open a ticket.
 *   5. Restock 5 tokens, reserve the 5th for the patron until UTC midnight.
 *      Public stock = 4. The reserved token is tracked in PatreonReservation.
 *   6. When the patron later opens a ticket (ticketManager), the reservation
 *      is consumed even if stock=0. If they never open a ticket by UTC midnight,
 *      the scheduler voids the reservation (no refund).
 */
export async function execute(interaction: any): Promise<void> {
  const userId = interaction.user.id;
  const guildId = interaction.guildId || '';
  const gameName = interaction.options.getString('game', true);

  // ── 1. Verify Patreon patron status and specific Bypass subscription ──
  const bypassTierId = (CONFIG.PATREON_TIER_BYPASS_ID || '').trim();
  if (!bypassTierId) {
    return interaction.editReply({
      content: `❌ **Bypass system offline:** The Patreon Bypass Tier ID is not configured on the bot server. Please contact an administrator.`,
    });
  }

  // Fetch campaign member details matching the user's discordId
  const patron = await (prisma as any).patreonMember.findFirst({
    where: {
      discordId: userId,
      patronStatus: 'active_patron',
    },
  });

  // Verify the user is a patron
  if (!patron) {
    const patreonUrl = CONFIG.PATREON_URL || 'https://www.patreon.com';
    return interaction.editReply({
      content:
        `❌ **Not a Patreon member.** You need an active Patreon subscription with your Discord account linked.\n\n` +
        `1. Subscribe at ${patreonUrl}\n` +
        `2. Link your Discord on [patreon.com → Settings → Connected Accounts](https://www.patreon.com/settings/apps)\n` +
        `3. Wait for the next sync (usually within 30 minutes) or ask staff to run \`/patreon sync\`.`,
    });
  }

  // Double check user actually has the bypass subscription tier active on their Patreon account.
  // Note: patreonMember table tracks tier. We need to check if the user is authorized.
  // We can fetch from Patreon API or look at their stored tiers. To be secure, let's fetch the member from Patreon or check if they have the specific role/tier.
  // Let's resolve the member from the database or check active status.
  // If the user's mapped tier in the patreonMember cache is not matching, or we need to look at raw tierIds from Patreon sync:
  // Let's import the Patreon client/helper if needed, or check if the user has the bypass tier.
  // Wait, let's look at the database row first: we store: tier: String? (mapped via resolveTier).
  // But wait, the bypass tier is a separate subscription. A patron might have bronze/silver/gold OR the bypass tier.
  // Let's check if the patron's db row has their active tier set to bypass, or verify their tierIds.
  // Wait, does resolveTier support the bypass tier? No, it's currently only gold/silver/bronze.
  // Let's write the check securely:
  // To avoid changing all role sync logic (if we don't want roles for Bypass), we can fetch the member directly from the Patreon API using the cached patreonMemberId in our database row, or we can check the Patreon API directly.
  // Even better: let's query the Patreon API directly or check if they have the Bypass tier.
  // Let's fetch the member using `fetchCampaignMember(patron.patreonMemberId)` to get their live `tierIds`.
  let apiMember;
  try {
    const { fetchCampaignMember } = await import('../utils/patreonClient');
    apiMember = await fetchCampaignMember(patron.patreonMemberId);
  } catch (e: any) {
    console.error('[Claim] Failed to fetch Patreon API member details:', e);
  }

  const hasBypassTier = apiMember?.tierIds?.includes(bypassTierId);

  if (!hasBypassTier) {
    return interaction.editReply({
      content: `❌ **No active Bypass subscription:** You are a patron, but you do not have the **Bypass / Token Reservation** tier active on your Patreon account.`,
    });
  }

  // ── 2. Validate the game ──
  const game = await prisma.game.findUnique({ where: { name: gameName } });

  if (!game || game.disabled) {
    return interaction.editReply({
      content: `❌ **Game not found:** No active game named **${gameName}**. Check the panel for available games.`,
    });
  }

  if (!game.highDemand) {
    return interaction.editReply({
      content:
        `❌ **Not eligible:** **${game.name}** is not a high-demand game. ` +
        `The \`/claim\` bypass is only available for 🔥 **High Demand** titles.`,
    });
  }

  // ── 3. Check monthly claim limit ──
  const now = new Date();
  const claimMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  const existingClaim = await (prisma as any).patreonReservation.findUnique({
    where: {
      userId_guildId_gameId_claimMonth: {
        userId,
        guildId,
        gameId: game.id,
        claimMonth,
      },
    },
  });

  if (existingClaim) {
    const statusLabel =
      existingClaim.status === 'ACTIVE'
        ? `⏳ Your reservation is still **active** — open a ticket for **${game.name}** before <t:${Math.floor(existingClaim.expiresAt.getTime() / 1000)}:F> to use it.`
        : existingClaim.status === 'FULFILLED'
          ? '✅ You already **used** your bypass this month for this game.'
          : '🚫 Your bypass for this month was **voided** (expired without being used).';

    return interaction.editReply({
      content:
        `❌ **Monthly limit reached:** You've already claimed a bypass for **${game.name}** this month (${claimMonth}).\n\n${statusLabel}`,
    });
  }

  // ── 4. Check stock — only allow /claim when game is OUT OF STOCK ──
  const serverStock = await getOrCreateServerStock(game.id, guildId);

  if (serverStock.stock > 0) {
    return interaction.editReply({
      content:
        `ℹ️ **${game.name}** currently has **${serverStock.stock}** token(s) in stock. ` +
        `No need to use your monthly bypass — just open a ticket from the panel!`,
    });
  }

  // ── 5. Restock 5 tokens, reserve the 5th for this patron ──
  // Compute UTC midnight for expiry
  const utcMidnight = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1, // next day
    0, 0, 0, 0,
  ));

  try {
    // Restock to 4 publicly visible (the 5th is the reserved one, tracked in DB)
    await prisma.serverStock.update({
      where: { gameId_guildId: { gameId: game.id, guildId } },
      data: {
        stock: 4,
        lastDepletedAt: null,
      },
    });

    // Create the reservation
    await (prisma as any).patreonReservation.create({
      data: {
        userId,
        guildId,
        gameId: game.id,
        claimMonth,
        status: 'ACTIVE',
        expiresAt: utcMidnight,
      },
    });
  } catch (e: any) {
    // Unique constraint = race condition (double-click)
    if (e?.code === 'P2002') {
      return interaction.editReply({
        content: `❌ You've already claimed a bypass for **${game.name}** this month.`,
      });
    }
    console.error('[Claim] Failed to create reservation:', e);
    return interaction.editReply({
      content: `❌ Something went wrong creating your reservation. Please try again or contact staff.`,
    });
  }

  // ── 6. Respond + log ──
  const expiryTimestamp = Math.floor(utcMidnight.getTime() / 1000);

  const embed = new EmbedBuilder()
    .setTitle('🎫 Bypass Token Reserved')
    .setDescription(
      `Your Patreon bypass for **${game.name}** has been reserved!\n\n` +
      `📌 **Open a ticket** from the panel for this game before the deadline to use your reserved token.\n\n` +
      `⏰ **Expires:** <t:${expiryTimestamp}:F> (<t:${expiryTimestamp}:R>)\n` +
      `⚠️ If you don't open a ticket by then, the reservation is **voided** and your monthly claim is NOT refunded.\n\n` +
      `🎁 **4 tokens** were also restocked for the community.`,
    )
    .setColor(0xF96854) // Patreon brand color
    .setFooter({ text: `Monthly claim used: ${claimMonth} • 1 per game per month` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  // Log to staff
  const guild = interaction.guild;
  if (guild) {
    await logAction(
      guild,
      '🎫 Patreon Bypass Claimed',
      `<@${userId}> reserved a bypass token for **${game.name}**.\n` +
      `Expires <t:${expiryTimestamp}:F>. 4 public tokens restocked.\n` +
      `Claim month: \`${claimMonth}\``,
      0xF96854,
    );
  }
}
