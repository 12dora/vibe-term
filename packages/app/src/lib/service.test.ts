import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunCommandResult } from './process';
import {
  buildLaunchdPlist,
  buildLegacyLaunchdPlist,
  buildSystemdServiceContent,
  ensureSystemdLinger,
  getServiceStatus,
  installLegacyLabelledService,
  installService,
  legacyLaunchdPlistPaths,
  removeLegacyLaunchdJob,
  stopService,
} from './service';

describe('buildSystemdServiceContent', () => {
  test('renders absolute WorkingDirectory without wrapping quotes', () => {
    const content = buildSystemdServiceContent({
      serviceName: 'vibeterm',
      installDir: '/home/krhougs/.local/share/vibeterm',
      runScriptPath: '/home/krhougs/.local/share/vibeterm/run.sh',
      autostart: true,
    });

    expect(content).toContain('WorkingDirectory=/home/krhougs/.local/share/vibeterm');
    expect(content).not.toContain('WorkingDirectory="/home/krhougs/.local/share/vibeterm"');
    expect(content).toContain(
      'ExecStart=/usr/bin/env bash "/home/krhougs/.local/share/vibeterm/run.sh"'
    );
    expect(content).toContain('SyslogIdentifier=vibeterm');
    expect(content).toContain('StandardOutput=journal');
    expect(content).toContain('StandardError=journal');
    expect(content).toContain('KillMode=process');
  });
});

describe('buildLaunchdPlist', () => {
  test('declares AbandonProcessGroup alongside KeepAlive', () => {
    const content = buildLaunchdPlist({
      serviceName: 'vibeterm',
      installDir: '/Users/krhougs/Library/Application Support/vibeterm',
      runScriptPath: '/Users/krhougs/Library/Application Support/vibeterm/run.sh',
      autostart: true,
    });

    expect(content).toContain('<key>KeepAlive</key>');
    expect(content).toContain('<key>AbandonProcessGroup</key>\n  <true/>');
    expect(content).toContain('<key>VIBETERM_LOG_FILE</key>');
    expect(content).toContain(
      '<string>/Users/krhougs/Library/Application Support/vibeterm/vibeterm.log</string>'
    );
    expect(content).toContain('<key>StandardOutPath</key>');
    expect(content).toContain('<key>StandardErrorPath</key>');
  });
});

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Call = string[];

function recorder(codes: Record<string, number> = {}) {
  const calls: Call[] = [];
  const run = async (command: string, args: string[]): Promise<RunCommandResult> => {
    calls.push([command, ...args]);
    const key = args.join(' ');
    // 默认「没有这个 job」：否则等待卸载的轮询会一直转下去
    const fallback = args[0] === 'print' ? 1 : 0;
    return { code: codes[key] ?? fallback, stdout: '', stderr: '' };
  };
  return { calls, run };
}

function bootoutTargets(calls: Call[]): string[] {
  // 按路径 bootout 是 `bootout gui/<uid> <path>`，按 label 是 `bootout gui/<uid>/<label>`
  return calls.filter((call) => call[1] === 'bootout').map((call) => call[3] ?? call[2]);
}

async function tempHome(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  await mkdir(join(dir, 'Library', 'LaunchAgents'), { recursive: true });
  return dir;
}

describe('pre-rename launchd job cleanup', () => {
  test('legacy plist paths use the com.tmex.<service> label', () => {
    expect(legacyLaunchdPlistPaths('tmex', '/opt/install')).toEqual([
      join(homedir(), 'Library', 'LaunchAgents', 'com.tmex.tmex.plist'),
      '/opt/install/com.tmex.tmex.plist',
    ]);
    expect(legacyLaunchdPlistPaths('tmex')).toHaveLength(1);
  });

  test('boots out and deletes the legacy plist that lives in the install dir', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-relabel-'));
    tempDirs.push(installDir);
    const legacyPlist = join(installDir, 'com.tmex.tmex.plist');
    await writeFile(legacyPlist, '<plist/>');
    const { calls, run } = recorder();

    const removed = await removeLegacyLaunchdJob('tmex', installDir, {
      homeDir: installDir,
      run,
    });

    expect(removed).toEqual([legacyPlist]);
    expect(bootoutTargets(calls)).toContain(legacyPlist);
    expect(await Bun.file(legacyPlist).exists()).toBe(false);
  });

  test('boots out by label even when the plist file is already gone', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-relabel-none-'));
    tempDirs.push(installDir);
    const { calls, run } = recorder();

    // 现网见过 plist 已删、job 仍在跑的机器：只按路径 bootout 会静默失败，旧进程继续占端口
    const removed = await removeLegacyLaunchdJob('vibeterm', installDir, {
      homeDir: installDir,
      run,
    });

    expect(removed).toEqual([]);
    expect(bootoutTargets(calls)).toContain(`gui/${process.getuid?.() ?? 0}/com.tmex.vibeterm`);
  });

  test('the legacy plist keeps the old label, log names and env keys', () => {
    const content = buildLegacyLaunchdPlist({
      serviceName: 'tmex',
      installDir: '/opt/install',
      runScriptPath: '/opt/install/run.sh',
      autostart: true,
    });
    expect(content).toContain('<string>com.tmex.tmex</string>');
    expect(content).toContain('<key>TMEX_LOG_FILE</key>');
    expect(content).toContain('<string>/opt/install/tmex.log</string>');
    expect(content).toContain('<string>/opt/install/tmex.err.log</string>');
  });
});

describe('service name migration cleanup', () => {
  test('launchd install removes the plist of the OLD service name', async () => {
    const home = await tempHome('vibeterm-svc-fwd-');
    const installDir = join(home, 'install');
    await mkdir(installDir, { recursive: true });
    const agents = join(home, 'Library', 'LaunchAgents');
    const oldPlist = join(agents, 'com.tmex.tmex.plist');
    await writeFile(oldPlist, '<plist/>');
    const { calls, run } = recorder();

    await installService(
      {
        serviceName: 'vibeterm',
        legacyServiceName: 'tmex',
        installDir,
        runScriptPath: join(installDir, 'run.sh'),
        autostart: true,
      },
      { manager: 'launchd', run, homeDir: home }
    );

    // 旧默认服务名的注册文件是 com.tmex.tmex.plist，不是 com.tmex.vibeterm.plist
    expect(await Bun.file(oldPlist).exists()).toBe(false);
    expect(bootoutTargets(calls)).toContain(oldPlist);
    const target = join(agents, 'com.vibeterm.vibeterm.plist');
    expect(await readFile(target, 'utf8')).toContain('<string>com.vibeterm.vibeterm</string>');
    expect(calls.some((call) => call[1] === 'bootstrap' && call[3] === target)).toBe(true);
  });

  test('the rollback install removes the NEW registration and writes the old label', async () => {
    const home = await tempHome('vibeterm-svc-back-');
    const installDir = join(home, 'install');
    await mkdir(installDir, { recursive: true });
    const agents = join(home, 'Library', 'LaunchAgents');
    const newPlist = join(agents, 'com.vibeterm.vibeterm.plist');
    await writeFile(newPlist, '<plist/>');
    const { calls, run } = recorder();

    await installLegacyLabelledService(
      {
        serviceName: 'tmex',
        legacyServiceName: 'vibeterm',
        installDir,
        runScriptPath: join(installDir, 'run.sh'),
        autostart: true,
      },
      { manager: 'launchd', run, homeDir: home }
    );

    expect(await Bun.file(newPlist).exists()).toBe(false);
    expect(bootoutTargets(calls)).toContain(newPlist);
    const target = join(agents, 'com.tmex.tmex.plist');
    expect(await readFile(target, 'utf8')).toContain('<string>com.tmex.tmex</string>');
  });

  test('systemd install disables and deletes the old unit', async () => {
    const home = await tempHome('vibeterm-svc-systemd-');
    const installDir = join(home, 'install');
    await mkdir(join(home, '.config', 'systemd', 'user'), { recursive: true });
    await mkdir(installDir, { recursive: true });
    const oldUnit = join(home, '.config', 'systemd', 'user', 'tmex.service');
    await writeFile(oldUnit, '[Unit]\n');
    const { calls, run } = recorder();

    await installService(
      {
        serviceName: 'vibeterm',
        legacyServiceName: 'tmex',
        installDir,
        runScriptPath: join(installDir, 'run.sh'),
        autostart: false,
      },
      {
        manager: 'systemd-user',
        run,
        homeDir: home,
        oomConfigDir: join(home, '.config', 'systemd'),
      }
    );

    expect(await Bun.file(oldUnit).exists()).toBe(false);
    expect(calls).toContainEqual(['systemctl', '--user', 'disable', '--now', 'tmex']);
    const unit = join(home, '.config', 'systemd', 'user', 'vibeterm.service');
    expect(await readFile(unit, 'utf8')).toContain('Description=VibeTerm (vibeterm)');
  });

  test('stopService boots out both prefixes for both service names', async () => {
    const home = await tempHome('vibeterm-svc-stop-');
    const uid = process.getuid?.() ?? 0;
    const { calls, run } = recorder();

    await stopService('vibeterm', join(home, 'install'), {
      legacyServiceName: 'tmex',
      deps: { manager: 'launchd', run, homeDir: home },
    });

    const targets = bootoutTargets(calls);
    for (const label of [
      'com.vibeterm.vibeterm',
      'com.tmex.vibeterm',
      'com.vibeterm.tmex',
      'com.tmex.tmex',
    ]) {
      expect(targets).toContain(`gui/${uid}/${label}`);
    }
  });

  test('a job still loaded under the old label counts as running', async () => {
    const home = await tempHome('vibeterm-svc-status-');
    const uid = process.getuid?.() ?? 0;
    const { run } = recorder({
      [`print gui/${uid}/com.tmex.tmex`]: 0,
      [`print gui/${uid}/com.vibeterm.vibeterm`]: 1,
      [`print gui/${uid}/com.tmex.vibeterm`]: 1,
      [`print gui/${uid}/com.vibeterm.tmex`]: 1,
    });

    const status = await getServiceStatus('vibeterm', join(home, 'install'), {
      legacyServiceName: 'tmex',
      deps: { manager: 'launchd', run, homeDir: home },
    });

    expect(status.running).toBe(true);
  });
});

describe('systemd linger', () => {
  interface LingerOutcome {
    show?: Partial<RunCommandResult> | 'throw';
    enable?: Partial<RunCommandResult> | 'throw';
  }

  function lingerRunner(outcome: LingerOutcome = {}) {
    const calls: Call[] = [];
    const run = async (command: string, args: string[]): Promise<RunCommandResult> => {
      calls.push([command, ...args]);
      if (command !== 'loginctl') return { code: 0, stdout: '', stderr: '' };
      const step = args[0] === 'show-user' ? outcome.show : outcome.enable;
      if (step === 'throw') throw new Error('spawn loginctl ENOENT');
      return { code: 0, stdout: '', stderr: '', ...step };
    };
    return { calls, run };
  }

  function loginctlCalls(calls: Call[]): Call[] {
    return calls.filter((call) => call[0] === 'loginctl');
  }

  async function install(
    outcome: LingerOutcome,
    options: { autostart?: boolean; linger?: boolean; manager?: 'systemd-user' | 'launchd' } = {}
  ) {
    const home = await tempHome('vibeterm-svc-linger-');
    const installDir = join(home, 'install');
    await mkdir(installDir, { recursive: true });
    const { calls, run } = lingerRunner(outcome);
    const logs: string[] = [];
    const warns: string[] = [];
    await installService(
      {
        serviceName: 'vibeterm',
        installDir,
        runScriptPath: join(installDir, 'run.sh'),
        autostart: options.autostart ?? true,
        linger: options.linger,
      },
      {
        manager: options.manager ?? 'systemd-user',
        run,
        homeDir: home,
        oomConfigDir: join(home, '.config', 'systemd'),
        username: 'alice',
        log: (message) => logs.push(message),
        warn: (message) => warns.push(message),
      }
    );
    return { calls, logs, warns };
  }

  test('already enabled: checks only, changes nothing', async () => {
    const { calls, logs, warns } = await install({ show: { stdout: 'Linger=yes\n' } });

    expect(loginctlCalls(calls)).toEqual([['loginctl', 'show-user', 'alice', '-p', 'Linger']]);
    expect(logs).toEqual([]);
    expect(warns).toEqual([]);
  });

  test('not enabled: runs enable-linger for the current user before restarting', async () => {
    const { calls, logs, warns } = await install({ show: { stdout: 'Linger=no\n' } });

    expect(loginctlCalls(calls)).toEqual([
      ['loginctl', 'show-user', 'alice', '-p', 'Linger'],
      ['loginctl', 'enable-linger', 'alice'],
    ]);
    const enableAt = calls.findIndex((call) => call[1] === 'enable-linger');
    const restartAt = calls.findIndex((call) => call[0] === 'systemctl' && call[2] === 'restart');
    expect(enableAt).toBeGreaterThan(-1);
    expect(enableAt).toBeLessThan(restartAt);
    expect(logs).toHaveLength(1);
    expect(warns).toEqual([]);
  });

  test('show-user failing (no user manager yet) still tries enable-linger', async () => {
    const { calls, warns } = await install({ show: { code: 1, stderr: 'not logged in' } });

    expect(loginctlCalls(calls)).toContainEqual(['loginctl', 'enable-linger', 'alice']);
    expect(warns).toEqual([]);
  });

  test('enable-linger failing warns once with the manual command and does not fail the install', async () => {
    const { calls, warns } = await install({
      show: { stdout: 'Linger=no\n' },
      enable: { code: 1, stderr: 'Access denied' },
    });

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('sudo loginctl enable-linger alice');
    expect(calls).toContainEqual(['systemctl', '--user', 'restart', 'vibeterm']);
  });

  test('a missing loginctl warns instead of throwing', async () => {
    const { calls, warns } = await install({ show: 'throw' });

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('sudo loginctl enable-linger alice');
    expect(calls).toContainEqual(['systemctl', '--user', 'restart', 'vibeterm']);
  });

  test('linger: false skips every loginctl call', async () => {
    const { calls, logs, warns } = await install({}, { linger: false });

    expect(loginctlCalls(calls)).toEqual([]);
    expect(logs).toEqual([]);
    expect(warns).toEqual([]);
  });

  test('autostart off skips linger', async () => {
    const { calls } = await install({}, { autostart: false });

    expect(loginctlCalls(calls)).toEqual([]);
  });

  test('launchd never touches loginctl', async () => {
    const { calls } = await install({}, { manager: 'launchd' });

    expect(loginctlCalls(calls)).toEqual([]);
  });

  test('ensureSystemdLinger reports the outcome', async () => {
    const deps = (outcome: LingerOutcome) => ({
      run: lingerRunner(outcome).run,
      username: 'alice',
      log: () => {},
      warn: () => {},
    });

    expect(
      await ensureSystemdLinger({ autostart: true }, deps({ show: { stdout: 'Linger=yes' } }))
    ).toBe('already');
    expect(await ensureSystemdLinger({ autostart: true }, deps({}))).toBe('enabled');
    expect(await ensureSystemdLinger({ autostart: true }, deps({ enable: { code: 1 } }))).toBe(
      'failed'
    );
    expect(await ensureSystemdLinger({ autostart: true, linger: false }, deps({}))).toBe('skipped');
  });
});
