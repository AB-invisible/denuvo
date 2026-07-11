import { EmbedBuilder } from 'discord.js';
import { CONFIG } from '../config';
import { checkUbisoftServiceHealth, ubisoftServiceConfigured } from '../utils/ubisoftService';
import { magicFileStatus } from '../utils/ubisoftFlow';

/**
 * /ubisofthealth — owner-only: check the ubisoft-service connection + tool
 * presence and which magic-files zips are available for hosting.
 */
export async function execute(interaction: any): Promise<void> {
  if (interaction.guildId !== CONFIG.OWNER_GUILD_ID) {
    return interaction.editReply({ content: '❌ This command is only available in the owner server.' });
  }

  const configured = ubisoftServiceConfigured();
  const health = configured ? await checkUbisoftServiceHealth() : { ok: false, error: 'not configured' };
  const magic = magicFileStatus();

  const svcLine = !configured
    ? '🔴 Not configured — set `UBISOFT_SERVICE_URL` + `UBISOFT_SERVICE_KEY`.'
    : health.ok
    ? `🟢 Reachable · tool ${health.tool ? 'present ✅' : 'MISSING ⚠️'}`
    : `🔴 Unreachable — ${health.error ?? 'unknown error'}`;

  const magicLine = !magic.dir
    ? '⚠️ `UBISOFT_MAGIC_DIR` not set — magic files can only be delivered via attachment if present.'
    : magic.present.length
    ? magic.present.map((f) => `• \`${f}\``).join('\n')
    : `📭 No recognized magic-files zips found in \`${magic.dir}\`.`;

  const embed = new EmbedBuilder()
    .setTitle('🎮 Ubisoft Service Health')
    .addFields(
      { name: 'Token Service', value: svcLine },
      { name: `Magic Files${magic.dir ? ` (${magic.dir})` : ''}`, value: magicLine },
    )
    .setColor(health.ok ? 0x57f287 : 0xed4245)
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}
