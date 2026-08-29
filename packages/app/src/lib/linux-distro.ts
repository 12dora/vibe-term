import { readFile } from 'node:fs/promises';

export interface LinuxDistroInfo {
  id: string;
  idLike: string[];
  versionId?: string;
  name?: string;
}

export type PackageManagerFamily = 'apt' | 'dnf' | 'pacman' | 'apk' | 'zypper' | 'brew' | 'unknown';

export function parseOsRelease(content: string): LinuxDistroInfo | null {
  const lines = content.split('\n');
  const fields: Record<string, string> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 0) continue;
    const key = trimmed.slice(0, eqIndex);
    let value = trimmed.slice(eqIndex + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }

  const id = fields.ID;
  if (!id) return null;

  const idLikeRaw = fields.ID_LIKE;
  const idLike = idLikeRaw ? idLikeRaw.split(/\s+/).filter(Boolean) : [];

  return {
    id,
    idLike,
    versionId: fields.VERSION_ID,
    name: fields.NAME,
  };
}

export async function detectLinuxDistro(): Promise<LinuxDistroInfo | null> {
  try {
    const content = await readFile('/etc/os-release', 'utf-8');
    return parseOsRelease(content);
  } catch {
    return null;
  }
}

const LINUX_PACKAGE_MANAGER_PROBES: ReadonlyArray<{
  manager: Exclude<PackageManagerFamily, 'brew' | 'unknown'>;
  matches: (id: string) => boolean;
}> = [
  { manager: 'apt', matches: (id) => id === 'debian' || id === 'ubuntu' },
  { manager: 'dnf', matches: (id) => id === 'fedora' || id === 'rhel' || id === 'centos' },
  { manager: 'pacman', matches: (id) => id === 'arch' || id === 'manjaro' },
  { manager: 'apk', matches: (id) => id === 'alpine' },
  { manager: 'zypper', matches: (id) => id.startsWith('opensuse') || id === 'suse' },
];

export function detectPackageManager(
  distro: LinuxDistroInfo | null,
  platform: NodeJS.Platform = process.platform
): PackageManagerFamily {
  if (platform === 'darwin') return 'brew';
  if (platform !== 'linux') return 'unknown';
  if (!distro) return 'unknown';

  for (const id of [distro.id, ...distro.idLike]) {
    const lower = id.toLowerCase();
    for (const probe of LINUX_PACKAGE_MANAGER_PROBES) {
      if (probe.matches(lower)) return probe.manager;
    }
  }

  return 'unknown';
}
