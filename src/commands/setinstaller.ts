import { EmbedBuilder } from 'discord.js';
import { CONFIG } from '../config';
import { logAction } from '../utils/logging';
import { isOwnerInteraction } from '../utils/tenantCommands';
import {
  getInstallerCallhomeStatus,
  setInstallerCallhome,
  type InstallerPlatform,
} from '../utils/installerSettings';

function overrideLabel(on: boolean | null, envDefault: boolean): string {
  if (on === null) return `env default (${envDefault ? 'on' : 'off'})`;
  return on ? 'on' : 'off';
}

function flowHint(platform: InstallerPlatform, enabled: boolean): string {
  if (enabled) {
    return platform === 'ea'
      ? 'Users get **installer.exe** — no need to paste `Denuvo_ticket_*.txt` / `token_req.txt` unless the installer asks.'
      : 'Users get **installer.exe** — no need to paste `token_req.txt` unless the installer asks.';
  }
  return platform === 'ea'
    ? 'Users get the **manual magic zip** and paste **`Denuvo_ticket_*.txt`** or **`token_req.txt`** in the ticket.'
    : 'Users get the **manual magic zip** and paste **`token_req.txt`** in the ticket.';
}

/**
 * /setinstaller — owner-only: toggle the self-driving EA/Ubisoft installer on or off.
 * When off, tickets use the manual flow and accept pasted token request files.
 */
export async function execute(interaction: any): Promise<void> {
  if (interaction.guildId !== CONFIG.OWNER_GUILD_ID) {
    return interaction.editReply({ content: '❌ This command is only available in the owner server.' });
  }
  if (!isOwnerInteraction(interaction)) {
    return interaction.editReply({ content: '❌ **Owner only.**' });
  }

  const state = interaction.options.getString('state') as 'on' | 'off' | null;
  const platform = (interaction.options.getString('platform') || 'both') as InstallerPlatform | 'both';
  const status = await getInstallerCallhomeStatus();

  if (!state) {
    const embed = new EmbedBuilder()
      .setTitle('🔧 Installer call-home status')
      .setColor(0x5865f2)
      .setDescription(
        'Controls whether EA/Ubisoft tickets deliver the **self-driving installer** or the **manual magic-zip + paste token req** flow.',
      )
      .addFields(
        {
          name: '🎮 EA',
          value:
            `**${status.ea ? '🟢 ON' : '🔴 OFF'}** (${overrideLabel(status.eaOverride, status.envDefault)})\n` +
            flowHint('ea', status.ea),
          inline: false,
        },
        {
          name: '🎮 Ubisoft',
          value:
            `**${status.ubisoft ? '🟢 ON' : '🔴 OFF'}** (${overrideLabel(status.ubisoftOverride, status.envDefault)})\n` +
            flowHint('ubisoft', status.ubisoft),
          inline: false,
        },
        {
          name: 'Env fallback',
          value: `\`INSTALLER_CALLHOME\` = **${status.envDefault ? 'on' : 'off'}** (used when no runtime override is set)`,
          inline: false,
        },
      )
      .setFooter({ text: 'Use /setinstaller state:on|off platform:ea|ubisoft|both' });

    return interaction.editReply({ embeds: [embed] });
  }

  const enable = state === 'on';
  const target =
    platform === 'both' ? 'EA + Ubisoft' : platform === 'ea' ? 'EA' : 'Ubisoft';
  const currently =
    platform === 'both'
      ? status.ea === enable && status.ubisoft === enable
      : platform === 'ea'
        ? status.ea === enable
        : status.ubisoft === enable;

  if (currently) {
    return interaction.editReply({
      content: `ℹ️ **${target}** installer is already **${enable ? 'ON' : 'OFF'}**. No change.`,
    });
  }

  const updated = await setInstallerCallhome(platform, enable);

  const lines =
    platform === 'both'
      ? [
          `**EA:** ${updated.ea ? '🟢 ON' : '🔴 OFF'} — ${flowHint('ea', updated.ea)}`,
          `**Ubisoft:** ${updated.ubisoft ? '🟢 ON' : '🔴 OFF'} — ${flowHint('ubisoft', updated.ubisoft)}`,
        ]
      : [
          `**${target}:** ${enable ? '🟢 ON' : '🔴 OFF'} — ${flowHint(platform as InstallerPlatform, enable)}`,
        ];

  await interaction.editReply({
    content:
      `${enable ? '🟢' : '🔴'} **Installer ${enable ? 'enabled' : 'disabled'}** for **${target}**.\n\n` +
      lines.join('\n\n') +
      (enable
        ? ''
        : '\n\n_Open tickets already on the installer step can paste their token req file now._'),
  });

  if (interaction.guild) {
    await logAction(
      interaction.guild,
      enable ? '🟢 Installer Enabled' : '🔴 Installer Disabled',
      `${interaction.user} set **${target}** call-home installer to **${enable ? 'ON' : 'OFF'}**.`,
      enable ? 0x57f287 : 0xed4245,
    );
  }
}
