import prisma from '../lib/prisma';
import { CONFIG } from '../config';

export type InstallerPlatform = 'ea' | 'ubisoft';

const KEY_EA = 'installerCallhome:ea';
const KEY_UBISOFT = 'installerCallhome:ubisoft';

function envDefault(): boolean {
  return CONFIG.INSTALLER_CALLHOME;
}

async function readOverride(platform: InstallerPlatform): Promise<boolean | null> {
  const key = platform === 'ea' ? KEY_EA : KEY_UBISOFT;
  const row = await prisma.metadata.findUnique({ where: { key } });
  if (!row) return null;
  if (row.value === 'true') return true;
  if (row.value === 'false') return false;
  return null;
}

/** Whether the self-driving call-home installer is enabled for a platform. */
export async function isInstallerCallhomeEnabled(platform: InstallerPlatform): Promise<boolean> {
  const override = await readOverride(platform);
  return override ?? envDefault();
}

export async function getInstallerCallhomeStatus(): Promise<{
  ea: boolean;
  ubisoft: boolean;
  eaOverride: boolean | null;
  ubisoftOverride: boolean | null;
  envDefault: boolean;
}> {
  const [eaOverride, ubisoftOverride] = await Promise.all([
    readOverride('ea'),
    readOverride('ubisoft'),
  ]);
  const fallback = envDefault();
  return {
    ea: eaOverride ?? fallback,
    ubisoft: ubisoftOverride ?? fallback,
    eaOverride,
    ubisoftOverride,
    envDefault: fallback,
  };
}

export async function setInstallerCallhome(
  platform: InstallerPlatform | 'both',
  enabled: boolean,
): Promise<{ ea: boolean; ubisoft: boolean }> {
  const value = enabled ? 'true' : 'false';
  const targets: InstallerPlatform[] = platform === 'both' ? ['ea', 'ubisoft'] : [platform];

  await Promise.all(
    targets.map((p) => {
      const key = p === 'ea' ? KEY_EA : KEY_UBISOFT;
      return prisma.metadata.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      });
    }),
  );

  return getInstallerCallhomeStatus().then((s) => ({ ea: s.ea, ubisoft: s.ubisoft }));
}
