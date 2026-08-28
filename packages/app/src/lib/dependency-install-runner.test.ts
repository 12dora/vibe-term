import { describe, expect, test } from 'bun:test';
import { t } from '../i18n';
import {
  type DepInstallPlan,
  type InstallCommand,
  executeDependencyInstall,
  planBunInstall,
} from './dep-install';
import type { CommandSpawner, DependencyInstallRunnerDeps } from './dependency-install-runner';

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

function tmuxPlan(commands: InstallCommand[] = [brewCommand]): DepInstallPlan {
  return {
    dep: 'tmux',
    commands,
    requiredVersion: '>= 3.0',
    issue: 'missing',
  };
}

function bunPlan(): DepInstallPlan {
  return {
    dep: 'bun',
    commands: planBunInstall(),
    requiredVersion: '>= 1.3.0',
    issue: 'missing',
  };
}

interface SpawnCall {
  command: string;
  args: string[];
}

function createHarness(
  overrides: {
    exitCode?: number;
    spawnError?: Error;
    prompt?: boolean;
    bunOk?: boolean;
    tmuxOk?: boolean;
    sudoAvailable?: boolean;
    uid?: number;
    platform?: NodeJS.Platform;
  } = {}
) {
  const spawnCalls: SpawnCall[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const promptCalls: string[] = [];
  let bunChecks = 0;
  let tmuxChecks = 0;

  const runCommand: CommandSpawner = async (command, args) => {
    spawnCalls.push({ command, args });
    if (overrides.spawnError) throw overrides.spawnError;
    return { code: overrides.exitCode ?? 0, stdout: '', stderr: '' };
  };

  const deps: DependencyInstallRunnerDeps = {
    runCommand,
    promptConfirm: async (_ctx, message) => {
      promptCalls.push(message);
      return overrides.prompt ?? true;
    },
    checkBunVersion: async () => {
      bunChecks += 1;
      return { ok: overrides.bunOk ?? true };
    },
    checkTmuxVersion: async () => {
      tmuxChecks += 1;
      return { ok: overrides.tmuxOk ?? true };
    },
    isSudoAvailable: async () => overrides.sudoAvailable ?? true,
    uid: overrides.uid ?? 1000,
    platform: overrides.platform ?? 'darwin',
    log: (message) => {
      logs.push(message);
    },
    error: (message) => {
      errors.push(message);
    },
  };

  return {
    deps,
    spawnCalls,
    logs,
    errors,
    promptCalls,
    bunChecks: () => bunChecks,
    tmuxChecks: () => tmuxChecks,
  };
}

describe('executeDependencyInstall', () => {
  test('runs the install command and verifies the dependency on success', async () => {
    const harness = createHarness();
    const ok = await executeDependencyInstall(
      tmuxPlan(),
      { nonInteractive: false, autoConfirm: true },
      harness.deps
    );

    expect(ok).toBe(true);
    expect(harness.spawnCalls).toEqual([{ command: 'brew', args: ['install', 'tmux'] }]);
    expect(harness.tmuxChecks()).toBe(1);
    expect(harness.bunChecks()).toBe(0);
    expect(harness.promptCalls).toEqual([]);
    expect(harness.logs).toContain(`[tmex] ${t('deps.install.success', { dep: 'tmux' })}`);
  });

  test('returns false and skips verification when the install command exits non-zero', async () => {
    const harness = createHarness({ exitCode: 1 });
    const ok = await executeDependencyInstall(
      tmuxPlan(),
      { nonInteractive: false, autoConfirm: true },
      harness.deps
    );

    expect(ok).toBe(false);
    expect(harness.spawnCalls).toHaveLength(1);
    expect(harness.tmuxChecks()).toBe(0);
    expect(harness.errors).toContain(`[tmex] ${t('deps.install.failed', { dep: 'tmux' })}`);
    expect(harness.errors).toContain(`[tmex] ${t('deps.install.manual')}`);
  });

  test('returns false when install succeeds but version verification fails', async () => {
    const harness = createHarness({ tmuxOk: false });
    const ok = await executeDependencyInstall(
      tmuxPlan(),
      { nonInteractive: false, autoConfirm: true },
      harness.deps
    );

    expect(ok).toBe(false);
    expect(harness.spawnCalls).toHaveLength(1);
    expect(harness.tmuxChecks()).toBe(1);
    expect(harness.errors).toContain(`[tmex] ${t('deps.install.failed', { dep: 'tmux' })}`);
    expect(harness.errors).toContain(`[tmex] ${t('deps.install.manual')}`);
  });

  test('does not spawn when the user declines confirmation', async () => {
    const harness = createHarness({ prompt: false });
    const ok = await executeDependencyInstall(
      tmuxPlan(),
      { nonInteractive: false, autoConfirm: false },
      harness.deps
    );

    expect(ok).toBe(false);
    expect(harness.spawnCalls).toHaveLength(0);
    expect(harness.tmuxChecks()).toBe(0);
    expect(harness.promptCalls).toEqual([t('deps.install.confirm', { dep: 'tmux' })]);
    expect(harness.logs).toContain(
      `[tmex] ${t('deps.install.hint', { command: 'brew install tmux' })}`
    );
    expect(harness.errors).toEqual([]);
  });

  test('spawns after the user confirms the install', async () => {
    const harness = createHarness({ prompt: true });
    const ok = await executeDependencyInstall(
      tmuxPlan(),
      { nonInteractive: false, autoConfirm: false },
      harness.deps
    );

    expect(ok).toBe(true);
    expect(harness.promptCalls).toEqual([t('deps.install.confirm', { dep: 'tmux' })]);
    expect(harness.spawnCalls).toEqual([{ command: 'brew', args: ['install', 'tmux'] }]);
  });

  test('runs pipeline install commands through sh -c', async () => {
    const harness = createHarness();
    const ok = await executeDependencyInstall(
      bunPlan(),
      { nonInteractive: false, autoConfirm: true },
      harness.deps
    );

    expect(ok).toBe(true);
    expect(harness.spawnCalls).toEqual([
      { command: 'sh', args: ['-c', 'curl -fsSL https://bun.sh/install | bash'] },
    ]);
    expect(harness.bunChecks()).toBe(1);
    expect(harness.tmuxChecks()).toBe(0);
  });

  test('treats a thrown spawn as install failure', async () => {
    const harness = createHarness({ spawnError: new Error('spawn failed') });
    const ok = await executeDependencyInstall(
      tmuxPlan(),
      { nonInteractive: false, autoConfirm: true },
      harness.deps
    );

    expect(ok).toBe(false);
    expect(harness.tmuxChecks()).toBe(0);
    expect(harness.errors).toContain(`[tmex] ${t('deps.install.failed', { dep: 'tmux' })}`);
  });

  test('reports brew missing when tmux has no install commands on darwin', async () => {
    const harness = createHarness({ platform: 'darwin' });
    const ok = await executeDependencyInstall(
      tmuxPlan([]),
      { nonInteractive: false, autoConfirm: true },
      harness.deps
    );

    expect(ok).toBe(false);
    expect(harness.spawnCalls).toHaveLength(0);
    expect(harness.errors).toContain(`[tmex] ${t('deps.install.brewMissing')}`);
    expect(harness.errors).toContain(`[tmex] ${t('deps.install.manual')}`);
  });

  test('reports unknown distro when there are no install commands off darwin', async () => {
    const harness = createHarness({ platform: 'linux' });
    const ok = await executeDependencyInstall(
      tmuxPlan([]),
      { nonInteractive: false, autoConfirm: true },
      harness.deps
    );

    expect(ok).toBe(false);
    expect(harness.errors).toContain(`[tmex] ${t('deps.install.unknownDistro', { dep: 'tmux' })}`);
  });

  test('refuses non-interactive sudo install when sudo is unavailable', async () => {
    const harness = createHarness({ sudoAvailable: false, uid: 1000 });
    const ok = await executeDependencyInstall(
      tmuxPlan([aptCommand]),
      { nonInteractive: true, autoConfirm: true },
      harness.deps
    );

    expect(ok).toBe(false);
    expect(harness.spawnCalls).toHaveLength(0);
    expect(harness.errors).toContain(`[tmex] ${t('deps.install.sudoUnavailable')}`);
  });
});
