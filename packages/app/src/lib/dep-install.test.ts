import { describe, expect, test } from 'bun:test';
import {
  type InstallCommand,
  executeDependencyInstall,
  getInstallHint,
  getInstallHintAsync,
  isRootUid,
  planBunInstall,
  planBunInstallForHost,
  planTmuxInstall,
  resolveInstallCommand,
} from './dep-install';
import type { CommandSpawner, DependencyInstallRunnerDeps } from './dep-install-types';
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

const bunOfficialCommand: InstallCommand = {
  label: 'Official installer',
  command: 'curl -fsSL https://bun.sh/install | bash',
  requiresSudo: false,
  packageManager: 'curl',
};

const bunApkPrereqCommand: InstallCommand = {
  label: 'apk',
  command: 'apk add bash curl unzip libstdc++ libgcc',
  requiresSudo: true,
  packageManager: 'apk',
};

describe('planBunInstall', () => {
  test('returns official installer command by default', () => {
    expect(planBunInstall()).toEqual([bunOfficialCommand]);
  });

  test('keeps the official installer on non-apk linux distros', () => {
    expect(planBunInstall('linux', { distro: distro('ubuntu', ['debian']) })).toEqual([
      bunOfficialCommand,
    ]);
    expect(planBunInstall('linux', { packageManager: 'apt' })).toEqual([bunOfficialCommand]);
  });

  test('keeps the official installer on macOS', () => {
    expect(planBunInstall('darwin')).toEqual([bunOfficialCommand]);
  });

  test('splits apk prereqs and the official installer on alpine', () => {
    expect(planBunInstall('linux', { distro: distro('alpine') })).toEqual([
      bunApkPrereqCommand,
      bunOfficialCommand,
    ]);
  });

  test('splits apk prereqs for alpine derivatives via ID_LIKE', () => {
    expect(planBunInstall('linux', { distro: distro('postmarketos', ['alpine']) })).toEqual([
      bunApkPrereqCommand,
      bunOfficialCommand,
    ]);
  });

  test('splits apk prereqs when the package-manager family is apk', () => {
    expect(planBunInstall('linux', { packageManager: 'apk' })).toEqual([
      bunApkPrereqCommand,
      bunOfficialCommand,
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

describe('getInstallHintAsync', () => {
  test('returns official bun installer off linux', async () => {
    expect(await getInstallHintAsync('bun', 'darwin', async () => distro('alpine'))).toBe(
      bunOfficialCommand.command
    );
  });

  test('returns official bun installer on non-apk linux', async () => {
    expect(
      await getInstallHintAsync('bun', 'linux', async () => distro('ubuntu', ['debian']))
    ).toBe(bunOfficialCommand.command);
  });

  test('joins apk prereqs and the official bun installer on alpine', async () => {
    expect(await getInstallHintAsync('bun', 'linux', async () => distro('alpine'))).toBe(
      'sudo apk add bash curl unzip libstdc++ libgcc && curl -fsSL https://bun.sh/install | bash'
    );
  });

  test('returns sudo-prefixed tmux apk command on alpine', async () => {
    expect(await getInstallHintAsync('tmux', 'linux', async () => distro('alpine'))).toBe(
      'sudo apk add tmux'
    );
  });
});

describe('executeDependencyInstall', () => {
  test('runs apk prereqs with sudo then the bun installer as the user', async () => {
    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    const runCommand: CommandSpawner = async (command, args) => {
      spawnCalls.push({ command, args });
      return { code: 0, stdout: '', stderr: '' };
    };
    const deps: DependencyInstallRunnerDeps = {
      runCommand,
      promptConfirm: async () => true,
      checkBunVersion: async () => ({ ok: true }),
      checkTmuxVersion: async () => ({ ok: true }),
      isSudoAvailable: async () => true,
      uid: 1000,
      platform: 'linux',
      log: () => undefined,
      error: () => undefined,
    };

    const ok = await executeDependencyInstall(
      {
        dep: 'bun',
        commands: planBunInstall('linux', { packageManager: 'apk' }),
        requiredVersion: '>= 1.3.0',
        issue: 'missing',
      },
      { nonInteractive: false, autoConfirm: true },
      deps
    );

    expect(ok).toBe(true);
    expect(spawnCalls).toEqual([
      { command: 'sudo', args: ['apk', 'add', 'bash', 'curl', 'unzip', 'libstdc++', 'libgcc'] },
      { command: 'sh', args: ['-c', bunOfficialCommand.command] },
    ]);
  });

  test('does not prefix sudo for apk prereqs when already root', async () => {
    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    const runCommand: CommandSpawner = async (command, args) => {
      spawnCalls.push({ command, args });
      return { code: 0, stdout: '', stderr: '' };
    };
    const deps: DependencyInstallRunnerDeps = {
      runCommand,
      promptConfirm: async () => true,
      checkBunVersion: async () => ({ ok: true }),
      isSudoAvailable: async () => false,
      uid: 0,
      platform: 'linux',
      log: () => undefined,
      error: () => undefined,
    };

    const ok = await executeDependencyInstall(
      {
        dep: 'bun',
        commands: planBunInstall('linux', { packageManager: 'apk' }),
        requiredVersion: '>= 1.3.0',
        issue: 'missing',
      },
      { nonInteractive: true, autoConfirm: true },
      deps
    );

    expect(ok).toBe(true);
    expect(spawnCalls).toEqual([
      { command: 'apk', args: ['add', 'bash', 'curl', 'unzip', 'libstdc++', 'libgcc'] },
      { command: 'sh', args: ['-c', bunOfficialCommand.command] },
    ]);
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

describe('planBunInstallForHost', () => {
  test('detects the distro on linux and adds apk prerequisites on Alpine', async () => {
    const commands = await planBunInstallForHost('linux', async () => ({
      id: 'alpine',
      idLike: [],
    }));
    expect(commands.map((item) => item.packageManager)).toEqual(['apk', 'curl']);
  });

  test('skips distro detection off linux', async () => {
    let called = false;
    const commands = await planBunInstallForHost('darwin', async () => {
      called = true;
      return null;
    });
    expect(called).toBe(false);
    expect(commands).toHaveLength(1);
  });
});
