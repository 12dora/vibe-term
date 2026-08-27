import { describe, expect, test } from 'bun:test';
import {
  type InstallCommand,
  getInstallHint,
  isRootUid,
  planBunInstall,
  planTmuxInstall,
  resolveInstallCommand,
} from './dep-install';
import type { LinuxDistroInfo } from './linux-distro';

const available = async () => true;
const unavailable = async () => false;

function distro(id: string, idLike: string[] = []): LinuxDistroInfo {
  return { id, idLike };
}

const brewCommand: InstallCommand = {
  label: 'Homebrew',
  command: 'brew install tmux',
  requiresSudo: false,
  packageManager: 'brew',
};

const aptCommand: InstallCommand = {
  label: 'apt',
  command: 'apt install -y tmux',
  requiresSudo: true,
  packageManager: 'apt',
};

describe('planBunInstall', () => {
  test('returns official installer command', () => {
    expect(planBunInstall()).toEqual([
      {
        label: 'Official installer',
        command: 'curl -fsSL https://bun.sh/install | bash',
        requiresSudo: false,
        packageManager: 'curl',
      },
    ]);
  });
});

describe('planTmuxInstall', () => {
  test('returns brew command on macOS when brew is available', async () => {
    const commands = await planTmuxInstall('darwin', { isCommandAvailable: available });
    expect(commands).toEqual([brewCommand]);
  });

  test('returns empty on macOS when brew is unavailable', async () => {
    const commands = await planTmuxInstall('darwin', { isCommandAvailable: unavailable });
    expect(commands).toEqual([]);
  });

  test('returns apt command on debian/ubuntu', async () => {
    const commands = await planTmuxInstall('linux', {
      detectLinuxDistro: async () => distro('ubuntu', ['debian']),
    });
    expect(commands).toEqual([aptCommand]);
  });

  test('returns dnf command on fedora/rhel', async () => {
    const commands = await planTmuxInstall('linux', {
      detectLinuxDistro: async () => distro('fedora'),
    });
    expect(commands).toEqual([
      {
        label: 'dnf',
        command: 'dnf install -y tmux',
        requiresSudo: true,
        packageManager: 'dnf',
      },
    ]);
  });

  test('returns pacman command on arch', async () => {
    const commands = await planTmuxInstall('linux', {
      detectLinuxDistro: async () => distro('arch'),
    });
    expect(commands).toEqual([
      {
        label: 'pacman',
        command: 'pacman -S --noconfirm tmux',
        requiresSudo: true,
        packageManager: 'pacman',
      },
    ]);
  });

  test('returns apk command on alpine', async () => {
    const commands = await planTmuxInstall('linux', {
      detectLinuxDistro: async () => distro('alpine'),
    });
    expect(commands).toEqual([
      {
        label: 'apk',
        command: 'apk add tmux',
        requiresSudo: true,
        packageManager: 'apk',
      },
    ]);
  });

  test('returns zypper command on opensuse', async () => {
    const commands = await planTmuxInstall('linux', {
      detectLinuxDistro: async () => distro('opensuse-tumbleweed', ['suse']),
    });
    expect(commands).toEqual([
      {
        label: 'zypper',
        command: 'zypper install -y tmux',
        requiresSudo: true,
        packageManager: 'zypper',
      },
    ]);
  });

  test('returns empty for unknown linux distro', async () => {
    const commands = await planTmuxInstall('linux', {
      detectLinuxDistro: async () => distro('gentoo'),
    });
    expect(commands).toEqual([]);
  });

  test('returns empty when linux distro cannot be detected', async () => {
    const commands = await planTmuxInstall('linux', {
      detectLinuxDistro: async () => null,
    });
    expect(commands).toEqual([]);
  });

  test('returns empty for unsupported platforms', async () => {
    const commands = await planTmuxInstall('win32' as NodeJS.Platform);
    expect(commands).toEqual([]);
  });
});

describe('getInstallHint', () => {
  test('returns bun install command for bun', () => {
    expect(getInstallHint('bun')).toBe('curl -fsSL https://bun.sh/install | bash');
    expect(getInstallHint('bun', 'linux')).toBe('curl -fsSL https://bun.sh/install | bash');
    expect(getInstallHint('bun', 'darwin')).toBe('curl -fsSL https://bun.sh/install | bash');
  });

  test('returns brew for tmux on macOS', () => {
    expect(getInstallHint('tmux', 'darwin')).toBe('brew install tmux');
  });

  test('returns generic command for tmux on linux', () => {
    expect(getInstallHint('tmux', 'linux')).toBe('apt/dnf/pacman/apk install tmux');
  });
});

describe('isRootUid', () => {
  test('returns true only for uid 0', () => {
    expect(isRootUid(0)).toBe(true);
    expect(isRootUid(501)).toBe(false);
    expect(isRootUid(undefined)).toBe(false);
  });
});

describe('resolveInstallCommand', () => {
  test('does not prefix sudo when already root', () => {
    expect(resolveInstallCommand(aptCommand, 0)).toBe('apt install -y tmux');
  });

  test('prefixes sudo for non-root when required', () => {
    expect(resolveInstallCommand(aptCommand, 1000)).toBe('sudo apt install -y tmux');
    expect(resolveInstallCommand(aptCommand, undefined)).toBe('sudo apt install -y tmux');
  });

  test('never prefixes sudo when the command does not require it', () => {
    expect(resolveInstallCommand(brewCommand, 0)).toBe('brew install tmux');
    expect(resolveInstallCommand(brewCommand, 1000)).toBe('brew install tmux');
  });
});
