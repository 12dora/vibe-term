import { describe, expect, test } from 'bun:test';
import { t } from '../i18n';
import {
  type DepInstallPlan,
  type ExecuteDependencyInstallDeps,
  type InstallCommand,
  executeDependencyInstall,
  getInstallHint,
  isRootUid,
  planBunInstall,
  planTmuxInstall,
  resolveInstallCommand,
} from './dep-install';
import type { LinuxDistroInfo } from './linux-distro';
import type { RunCommandResult } from './process';

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

type RunCall = {
  command: string;
  args: string[];
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: 'inherit' | 'pipe';
    timeoutMs?: number;
  };
};

function bunPlan(commands: InstallCommand[] = planBunInstall()): DepInstallPlan {
  return { dep: 'bun', commands, requiredVersion: '>= 1.3.0', issue: 'missing' };
}

function tmuxPlan(commands: InstallCommand[]): DepInstallPlan {
  return { dep: 'tmux', commands, requiredVersion: '>= 3.0', issue: 'missing' };
}

function okResult(): RunCommandResult {
  return { code: 0, stdout: '', stderr: '' };
}

function failResult(): RunCommandResult {
  return { code: 1, stdout: '', stderr: '' };
}

async function runInstall(
  plan: DepInstallPlan,
  options: { nonInteractive: boolean; autoConfirm: boolean },
  extras: {
    uid?: number;
    platform?: NodeJS.Platform;
    runQueue?: Array<RunCommandResult | Error>;
    confirm?: boolean;
    bunOk?: boolean;
    tmuxOk?: boolean;
  } = {}
) {
  const calls: RunCall[] = [];
  const prompts: Array<{ nonInteractive: boolean; message: string; defaultValue: boolean }> = [];
  let bunChecks = 0;
  let tmuxChecks = 0;
  const logs: string[] = [];
  const errors: string[] = [];
  const queue = extras.runQueue ? [...extras.runQueue] : [];

  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };

  try {
    const deps: ExecuteDependencyInstallDeps = {
      getuid: () => extras.uid ?? 1000,
      platform: extras.platform ?? 'linux',
      runCommand: async (command, args, options) => {
        calls.push({ command, args, options });
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next ?? okResult();
      },
      promptConfirm: async (ctx, message, defaultValue) => {
        prompts.push({ nonInteractive: ctx.nonInteractive, message, defaultValue });
        return extras.confirm ?? true;
      },
      checkBunVersion: async () => {
        bunChecks += 1;
        return { ok: extras.bunOk ?? true };
      },
      checkTmuxVersion: async () => {
        tmuxChecks += 1;
        return { ok: extras.tmuxOk ?? true };
      },
    };

    const ok = await executeDependencyInstall(plan, options, deps);
    return { ok, calls, prompts, bunChecks, tmuxChecks, logs, errors };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe('executeDependencyInstall', () => {
  test('empty tmux plan on darwin reports brew missing and does not run a command', async () => {
    const result = await runInstall(
      tmuxPlan([]),
      { nonInteractive: true, autoConfirm: true },
      {
        platform: 'darwin',
      }
    );
    expect(result.ok).toBe(false);
    expect(result.calls).toEqual([]);
    expect(result.errors).toEqual([
      `[tmex] ${t('deps.install.brewMissing')}`,
      `[tmex] ${t('deps.install.manual')}`,
    ]);
  });

  test('empty plan on linux reports unknown distro', async () => {
    const result = await runInstall(bunPlan([]), { nonInteractive: true, autoConfirm: true });
    expect(result.ok).toBe(false);
    expect(result.calls).toEqual([]);
    expect(result.errors).toEqual([
      `[tmex] ${t('deps.install.unknownDistro', { dep: 'bun' })}`,
      `[tmex] ${t('deps.install.manual')}`,
    ]);
  });

  test('empty tmux plan on linux reports unknown distro not brew missing', async () => {
    const result = await runInstall(
      tmuxPlan([]),
      { nonInteractive: true, autoConfirm: true },
      {
        platform: 'linux',
      }
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe(`[tmex] ${t('deps.install.unknownDistro', { dep: 'tmux' })}`);
  });

  test('non-root non-interactive sudo command probes sudo -n true before install', async () => {
    const result = await runInstall(
      tmuxPlan([aptCommand]),
      { nonInteractive: true, autoConfirm: true },
      { uid: 1000, tmuxOk: true }
    );
    expect(result.ok).toBe(true);
    expect(result.calls).toEqual([
      { command: 'sudo', args: ['-n', 'true'], options: { stdio: 'pipe', timeoutMs: 5000 } },
      { command: 'sudo', args: ['apt', 'install', '-y', 'tmux'], options: { stdio: 'inherit' } },
    ]);
    expect(result.tmuxChecks).toBe(1);
    expect(result.bunChecks).toBe(0);
  });

  test('non-root non-interactive aborts when sudo -n true fails and skips install', async () => {
    const result = await runInstall(
      tmuxPlan([aptCommand]),
      { nonInteractive: true, autoConfirm: true },
      { uid: 1000, runQueue: [failResult()] }
    );
    expect(result.ok).toBe(false);
    expect(result.calls).toEqual([
      { command: 'sudo', args: ['-n', 'true'], options: { stdio: 'pipe', timeoutMs: 5000 } },
    ]);
    expect(result.tmuxChecks).toBe(0);
    expect(result.errors).toEqual([`[tmex] ${t('deps.install.sudoUnavailable')}`]);
  });

  test('root skips sudo probe and runs the command without a sudo prefix', async () => {
    const result = await runInstall(
      tmuxPlan([aptCommand]),
      { nonInteractive: true, autoConfirm: true },
      { uid: 0, tmuxOk: true }
    );
    expect(result.ok).toBe(true);
    expect(result.calls).toEqual([
      { command: 'apt', args: ['install', '-y', 'tmux'], options: { stdio: 'inherit' } },
    ]);
  });

  test('command that does not require sudo never probes sudo', async () => {
    const result = await runInstall(
      tmuxPlan([brewCommand]),
      { nonInteractive: true, autoConfirm: true },
      { uid: 1000, tmuxOk: true }
    );
    expect(result.ok).toBe(true);
    expect(result.calls).toEqual([
      { command: 'brew', args: ['install', 'tmux'], options: { stdio: 'inherit' } },
    ]);
  });

  test('interactive sudo command does not probe sudo -n true', async () => {
    const result = await runInstall(
      tmuxPlan([aptCommand]),
      { nonInteractive: false, autoConfirm: true },
      { uid: 1000, tmuxOk: true }
    );
    expect(result.ok).toBe(true);
    expect(result.calls).toEqual([
      { command: 'sudo', args: ['apt', 'install', '-y', 'tmux'], options: { stdio: 'inherit' } },
    ]);
    expect(result.prompts).toEqual([]);
  });

  test('non-interactive without autoConfirm probes sudo then refuses to prompt', async () => {
    const result = await runInstall(
      tmuxPlan([aptCommand]),
      { nonInteractive: true, autoConfirm: false },
      { uid: 1000 }
    );
    expect(result.ok).toBe(false);
    expect(result.calls).toEqual([
      { command: 'sudo', args: ['-n', 'true'], options: { stdio: 'pipe', timeoutMs: 5000 } },
    ]);
    expect(result.prompts).toEqual([]);
    expect(result.errors).toEqual([`[tmex] ${t('deps.install.nonInteractive', { dep: 'tmux' })}`]);
  });

  test('interactive without autoConfirm aborts when the user declines', async () => {
    const result = await runInstall(
      tmuxPlan([brewCommand]),
      { nonInteractive: false, autoConfirm: false },
      { confirm: false }
    );
    expect(result.ok).toBe(false);
    expect(result.calls).toEqual([]);
    expect(result.prompts).toEqual([
      {
        nonInteractive: false,
        message: t('deps.install.confirm', { dep: 'tmux' }),
        defaultValue: true,
      },
    ]);
  });

  test('interactive without autoConfirm runs the command after confirm', async () => {
    const result = await runInstall(
      tmuxPlan([brewCommand]),
      { nonInteractive: false, autoConfirm: false },
      { confirm: true, tmuxOk: true }
    );
    expect(result.ok).toBe(true);
    expect(result.calls).toEqual([
      { command: 'brew', args: ['install', 'tmux'], options: { stdio: 'inherit' } },
    ]);
  });

  test('pipeline command runs through sh -c with the full string', async () => {
    const result = await runInstall(
      bunPlan(),
      { nonInteractive: true, autoConfirm: true },
      {
        bunOk: true,
      }
    );
    expect(result.ok).toBe(true);
    expect(result.calls).toEqual([
      {
        command: 'sh',
        args: ['-c', 'curl -fsSL https://bun.sh/install | bash'],
        options: { stdio: 'inherit' },
      },
    ]);
    expect(result.bunChecks).toBe(1);
    expect(result.tmuxChecks).toBe(0);
  });

  test('pipeline failure skips verification', async () => {
    const result = await runInstall(
      bunPlan(),
      { nonInteractive: true, autoConfirm: true },
      {
        runQueue: [failResult()],
      }
    );
    expect(result.ok).toBe(false);
    expect(result.bunChecks).toBe(0);
    expect(result.errors).toEqual([
      `[tmex] ${t('deps.install.failed', { dep: 'bun' })}`,
      `[tmex] ${t('deps.install.manual')}`,
    ]);
  });

  test('direct command throw is treated as install failure', async () => {
    const result = await runInstall(
      tmuxPlan([brewCommand]),
      { nonInteractive: true, autoConfirm: true },
      { runQueue: [new Error('spawn failed')] }
    );
    expect(result.ok).toBe(false);
    expect(result.tmuxChecks).toBe(0);
  });

  test('bun verification failure after successful pipeline', async () => {
    const result = await runInstall(
      bunPlan(),
      { nonInteractive: true, autoConfirm: true },
      {
        bunOk: false,
      }
    );
    expect(result.ok).toBe(false);
    expect(result.bunChecks).toBe(1);
    expect(result.errors).toEqual([
      `[tmex] ${t('deps.install.failed', { dep: 'bun' })}`,
      `[tmex] ${t('deps.install.manual')}`,
    ]);
  });

  test('tmux verification failure after successful direct install', async () => {
    const result = await runInstall(
      tmuxPlan([brewCommand]),
      { nonInteractive: true, autoConfirm: true },
      { tmuxOk: false }
    );
    expect(result.ok).toBe(false);
    expect(result.tmuxChecks).toBe(1);
    expect(result.bunChecks).toBe(0);
  });
});
