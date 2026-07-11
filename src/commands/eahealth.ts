import { EmbedBuilder } from 'discord.js';
import { CONFIG } from '../config';
import { checkEaServiceHealth, eaServiceConfigured } from '../utils/eaService';
import { eaMagicFileStatus } from '../utils/eaFlow';

/**
 * /eahealth — owner-only: check the ea-service connection + tool presence.
 */
export async function execute(interaction: any): Promise<void> {
  if (interaction.guildId !== CONFIG.OWNER_GUILD_ID) {
    return interaction.editReply({ content: '❌ This command is only available in the owner server.' });
  }

  const configured = eaServiceConfigured();
  const health = configured ? await checkEaServiceHealth() : { ok: false, error: 'not configured' };
  const magic = eaMagicFileStatus();

  const svcLine = !configured
    ? '🔴 Not configured — set `EA_SERVICE_URL` + `EA_SERVICE_KEY`.'
    : health.ok
    ? `🟢 Reachable · python minter ${health.tool ? 'ready ✅' : 'MISSING ⚠️'}${health.configured === false ? ' · env incomplete (remid/signature/machine hash)' : ''}`
    : `🔴 Unreachable — ${health.error ?? 'unknown error'}`;

  const magicLine = [
    magic.present.length ? magic.present.map((f) => `• \`${f}\` (hosted)`).join('\n') : null,
    magic.external.length ? magic.external.map((f) => `• \`${f}\``).join('\n') : null,
    !magic.present.length && !magic.external.length
      ? `📭 No setup zips found in \`${magic.dir || 'ea-magic/'}\`. Upload zips to that folder (or set \`EA_MAGIC_DIR\`).`
      : null,
  ]
    .filter(Boolean)
    .join('\n') || '—';

  const embed = new EmbedBuilder()
    .setTitle('🎮 EA Token Service Health')
    .addFields(
      { name: 'Token Service', value: svcLine },
      { name: `Setup Zips${magic.dir ? ` (${magic.dir})` : ''}`, value: magicLine },
    )
    .setColor(health.ok ? 0x57f287 : 0xed4245)
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}
