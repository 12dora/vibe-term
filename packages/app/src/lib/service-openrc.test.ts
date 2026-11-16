import { afterEach, describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunCommandResult } from './process';
import {
  buildOpenrcInitScript,
  buildOpenrcSudoers,
  installOpenrcService,
  openrcSudoersFileName,
  parseRunlevelMembership,
  queryOpenrcStatus,
  restartOpenrcService,
  stopOpenrcService,
  uninstallOpenrcService,
} from './service-openrc';
import { OpenrcPrivilegeError, createPrivilegedRun } from './service-openrc-privilege';
import type { ServiceDeps } from './service-types';

const ok = (stdout = ''): RunCommandResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, code = 1): RunCommandResult => ({ code, stdout: '', stderr });
const NEEDS_PASSWORD = fail('sudo: a password is required');

const SCRIPT_OPTIONS = {
  serviceName: 'vibeterm',
  runScriptPath: '/home/alice/.local/share/vibeterm/run.sh',
  installDir: '/home/alice/.local/share/vibeterm',
  user: 'alice',
  group: 'alice',
  homeDir: '/home/alice',
};

describe('buildOpenrcInitScript', () => {
  const script = buildOpenrcInitScript(SCRIPT_OPTIONS);

  test('supervise-daemon runs run.sh as the installing user', () => {
    expect(script.startsWith('#!/sbin/openrc-run\n')).toBe(true);
    expect(script).toContain('supervisor=supervise-daemon\n');
    expect(script).toContain('command="/home/alice/.local/share/vibeterm/run.sh"\n');
    expect(script).toContain('command_args=""\n');
    expect(script).toContain('command_user="alice:alice"\n');
    expect(script).toContain('directory="/home/alice/.local/share/vibeterm"\n');
    expect(script).toContain('pidfile="/run/${RC_SVCNAME}.pid"\n');
    expect(script).not.toContain('command_background');
  });

  test('respawns forever and never sweeps the cgroup (tmux survives)', () => {
    expect(script).toContain('respawn_delay=3\n');
    expect(script).toContain('respawn_max=0\n');
    expect(script).toContain('retry="TERM/20/KILL/5"\n');
    expect(script).toContain('rc_cgroup_cleanup="no"\n');
  });

  test('logs to the install dir and exports the rotation env', () => {
    expect(script).toContain('output_log="/home/alice/.local/share/vibeterm/vibeterm.log"\n');
    expect(script).toContain('error_log="/home/alice/.local/share/vibeterm/vibeterm.err.log"\n');
    expect(script).toContain(
      '\texport VIBETERM_LOG_FILE="/home/alice/.local/share/vibeterm/vibeterm.log"\n'
    );
    expect(script).toContain(
      '\texport VIBETERM_LOG_ERR_FILE="/home/alice/.local/share/vibeterm/vibeterm.err.log"\n'
    );
    expect(script).toContain('\texport VIBETERM_SERVICE_MANAGER="openrc"\n');
  });

  test('exports HOME / USER / LOGNAME for the service user', () => {
    expect(script).toContain('\texport HOME="/home/alice"\n');
    expect(script).toContain('\texport USER="alice"\n');
    expect(script).toContain('\texport LOGNAME="alice"\n');
  });

  test('wants (not needs) net so boot never blocks on a missing net provider', () => {
    expect(script).toContain('depend() {\n\twant net\n\tafter firewall\n}\n');
    expect(script).not.toContain('need net');
  });

  test('escapes shell metacharacters inside double quotes', () => {
    const escaped = buildOpenrcInitScript({
      ...SCRIPT_OPTIONS,
      installDir: '/srv/a "b" $c `d`',
      group: undefined,
    });
    expect(escaped).toContain('directory="/srv/a \\"b\\" \\$c \\`d\\`"\n');
    expect(escaped).toContain('command_user="alice"\n');
  });
});

describe('sudoers rule', () => {
  test('only allows rc-service actions on this service', () => {
    const rule = buildOpenrcSudoers('alice', 'vibeterm', '/sbin/rc-service');
    expect(rule).toContain(
      'alice ALL=(root) NOPASSWD: /sbin/rc-service vibeterm start, /sbin/rc-service vibeterm stop, /sbin/rc-service vibeterm restart, /sbin/rc-service vibeterm status\n'
    );
  });

  test('file name has no dot (sudo skips such files)', () => {
    expect(openrcSudoersFileName('vibe.term')).toBe('vibeterm-vibe_term');
  });
});

describe('parseRunlevelMembership', () => {
  const output = '            sshd | default\n        vibeterm | default\n   vibeterm2 | default\n';
  test('matches the exact service name', () => {
    expect(parseRunlevelMembership(output, 'vibeterm')).toBe(true);
    expect(parseRunlevelMembership(output, 'vibe')).toBe(false);
  });
});

type Handler = (argv: string[]) => RunCommandResult | Promise<RunCommandResult> | undefined;

let roots: string[] = [];

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots = [];
});

async function fixture(options: { euid?: number; handler?: Handler; interactive?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vibeterm-openrc-test-'));
  roots.push(root);
  const initDir = join(root, 'init.d');
  const sudoersDir = join(root, 'sudoers.d');
  await mkdir(initDir, { recursive: true });
  await mkdir(sudoersDir, { recursive: true });
  const calls: string[] = [];
  const runlevel = new Set<string>();
  const running = new Set<string>();

  const builtin = async (argv: string[]): Promise<RunCommandResult> => {
    const [cmd, ...args] = argv;
    if (cmd === 'install') {
      await copyFile(args[2], args[3]);
      return ok();
    }
    if (cmd === 'rm') {
      for (const path of args.slice(1)) await rm(path, { force: true });
      return ok();
    }
    if (cmd === '/sbin/rc-update' && args[0] === 'show') {
      return ok([...runlevel].map((name) => `  ${name} | default`).join('\n'));
    }
    if (cmd === '/sbin/rc-update') {
      if (args[0] === 'add') runlevel.add(args[1]);
      else runlevel.delete(args[1]);
      return ok();
    }
    if (cmd === '/sbin/rc-service') {
      const [name, action] = args;
      if (action === 'status') return running.has(name) ? ok(' * status: started') : fail('', 3);
      if (action === 'stop') running.delete(name);
      else running.add(name);
      return ok();
    }
    return ok();
  };

  const run = (async (command: string, args: string[]) => {
    const argv = [command, ...args];
    calls.push(argv.join(' '));
    const custom = await options.handler?.(argv);
    if (custom) return custom;
    if (command === 'sudo' && args[0] === '-n' && args[1] !== '-l') return builtin(args.slice(1));
    if (command === 'sudo') return fail('sudo: a password is required');
    return builtin(argv);
  }) as NonNullable<ServiceDeps['run']>;

  const deps: ServiceDeps = {
    run,
    euid: options.euid ?? 1000,
    isInteractive: () => options.interactive ?? false,
    resolveBin: (name) => `/sbin/${name}`,
    openrcInitDir: initDir,
    sudoersDir,
    username: 'alice',
    groupName: 'alice',
    homeDir: '/home/alice',
    log: () => undefined,
    warn: () => undefined,
  };
  return { root, initDir, sudoersDir, calls, deps, runlevel, running };
}

const INSTALL = {
  serviceName: 'vibeterm',
  runScriptPath: '/home/alice/.local/share/vibeterm/run.sh',
  installDir: '/home/alice/.local/share/vibeterm',
  autostart: true,
};

const stripStaged = (calls: string[]) =>
  calls.map((call) => call.replace(/\S*vibeterm-openrc-[^/\s]+\/staged/g, '<staged>'));

describe('installOpenrcService', () => {
  test('root: writes the script and controls the service without sudo', async () => {
    const f = await fixture({ euid: 0 });
    await installOpenrcService(INSTALL, f.deps);

    const script = await readFile(join(f.initDir, 'vibeterm'), 'utf8');
    expect(script).toContain('command_user="alice:alice"');
    expect(stripStaged(f.calls)).toEqual([
      `install -m 0755 <staged> ${join(f.initDir, 'vibeterm')}`,
      '/sbin/rc-update show default',
      '/sbin/rc-update add vibeterm default',
      '/sbin/rc-service vibeterm status',
      '/sbin/rc-service vibeterm start',
    ]);
    expect(f.calls.some((call) => call.startsWith('sudo'))).toBe(false);
  });

  test('non-root with passwordless sudo: every privileged step goes through sudo -n', async () => {
    const f = await fixture();
    await installOpenrcService(INSTALL, f.deps);

    const sudoers = join(f.sudoersDir, 'vibeterm-vibeterm');
    expect(stripStaged(f.calls)).toEqual([
      `sudo -n install -m 0755 <staged> ${join(f.initDir, 'vibeterm')}`,
      'sudo -n -l /sbin/rc-service vibeterm restart',
      'sudo -n visudo -cf <staged>',
      `sudo -n install -m 0440 <staged> ${sudoers}`,
      '/sbin/rc-update show default',
      'sudo -n /sbin/rc-update add vibeterm default',
      '/sbin/rc-service vibeterm status',
      'sudo -n /sbin/rc-service vibeterm start',
    ]);
    expect(await readFile(sudoers, 'utf8')).toContain('alice ALL=(root) NOPASSWD:');
  });

  test('re-install with identical script and rule: only restarts', async () => {
    const f = await fixture({
      handler: (argv) => (argv.join(' ').startsWith('sudo -n -l') ? ok('allowed') : undefined),
    });
    await installOpenrcService(INSTALL, f.deps);
    f.calls.length = 0;
    await installOpenrcService(INSTALL, f.deps);

    expect(f.calls).toEqual([
      'sudo -n -l /sbin/rc-service vibeterm restart',
      '/sbin/rc-update show default',
      '/sbin/rc-service vibeterm status',
      'sudo -n /sbin/rc-service vibeterm restart',
    ]);
  });

  test('autostart=false removes the service from the default runlevel', async () => {
    const f = await fixture({ euid: 0 });
    f.runlevel.add('vibeterm');
    await installOpenrcService({ ...INSTALL, autostart: false }, f.deps);
    expect(f.calls).toContain('/sbin/rc-update del vibeterm default');
    expect(f.runlevel.has('vibeterm')).toBe(false);
  });

  test('sudo needs a password and there is no TTY: clear error, nothing written', async () => {
    const f = await fixture({
      handler: (argv) => (argv[0] === 'sudo' ? NEEDS_PASSWORD : undefined),
    });
    const error = await installOpenrcService(INSTALL, f.deps).catch((err) => err);
    expect(error).toBeInstanceOf(OpenrcPrivilegeError);
    expect(String(error.message)).toContain('--no-service');
    expect(f.calls.some((call) => call.startsWith('sudo -v'))).toBe(false);
  });

  test('sudo missing entirely: same clear error', async () => {
    const f = await fixture({
      handler: (argv) => {
        if (argv[0] === 'sudo') throw new Error('spawn sudo ENOENT');
        return undefined;
      },
    });
    const error = await installOpenrcService(INSTALL, f.deps).catch((err) => err);
    expect(error).toBeInstanceOf(OpenrcPrivilegeError);
  });

  test('rejects unsafe service names before touching anything', async () => {
    const f = await fixture({ euid: 0 });
    const error = await installOpenrcService({ ...INSTALL, serviceName: '../evil' }, f.deps).catch(
      (err) => err
    );
    expect(error).toBeInstanceOf(Error);
    expect(f.calls).toEqual([]);
  });

  test('legacy service name is stopped, disabled and removed first', async () => {
    const f = await fixture({ euid: 0 });
    await writeFile(join(f.initDir, 'tmex'), '#!/sbin/openrc-run\n');
    f.runlevel.add('tmex');
    await installOpenrcService({ ...INSTALL, legacyServiceName: 'tmex' }, f.deps);
    expect(f.calls.slice(0, 4)).toEqual([
      '/sbin/rc-service tmex stop',
      '/sbin/rc-update show default',
      '/sbin/rc-update del tmex default',
      `rm -f ${join(f.initDir, 'tmex')}`,
    ]);
  });
});

describe('createPrivilegedRun', () => {
  test('falls back to one interactive sudo -v, then retries with sudo -n', async () => {
    let validated = false;
    const calls: string[] = [];
    const logs: string[] = [];
    const run = (async (command: string, args: string[]) => {
      calls.push([command, ...args].join(' '));
      if (args[0] === '-v') {
        validated = true;
        return ok();
      }
      return validated ? ok() : NEEDS_PASSWORD;
    }) as NonNullable<ServiceDeps['run']>;
    const privileged = createPrivilegedRun({
      run,
      euid: 1000,
      isInteractive: () => true,
      log: (line) => logs.push(line),
    });
    await privileged(['/sbin/rc-service', 'vibeterm', 'start']);
    await privileged(['/sbin/rc-service', 'vibeterm', 'status']);
    expect(calls).toEqual([
      'sudo -n /sbin/rc-service vibeterm start',
      'sudo -v',
      'sudo -n /sbin/rc-service vibeterm start',
      'sudo -n /sbin/rc-service vibeterm status',
    ]);
    expect(logs).toHaveLength(1);
  });

  test('a failing command (not a sudo auth error) is returned, not escalated', async () => {
    const run = (async () => fail(' * ERROR: vibeterm failed')) as NonNullable<ServiceDeps['run']>;
    const privileged = createPrivilegedRun({ run, euid: 1000, isInteractive: () => true });
    const result = await privileged(['/sbin/rc-service', 'vibeterm', 'start']);
    expect(result.code).toBe(1);
  });

  test('denied after validation → privilege error', async () => {
    const denied = fail('Sorry, user alice is not allowed to execute rc-service');
    const run = (async (_command: string, args: string[]) =>
      args[0] === '-v' ? ok() : denied) as NonNullable<ServiceDeps['run']>;
    const privileged = createPrivilegedRun({ run, euid: 1000, isInteractive: () => true });
    await expect(privileged(['rm', '-f', '/etc/init.d/x'])).rejects.toBeInstanceOf(
      OpenrcPrivilegeError
    );
  });
});

describe('uninstall / stop / restart / status', () => {
  test('uninstall stops, disables and removes script and sudoers rule', async () => {
    const f = await fixture();
    await installOpenrcService(INSTALL, f.deps);
    f.calls.length = 0;
    await uninstallOpenrcService('vibeterm', f.deps);
    expect(f.calls).toEqual([
      'sudo -n /sbin/rc-service vibeterm stop',
      '/sbin/rc-update show default',
      'sudo -n /sbin/rc-update del vibeterm default',
      `sudo -n rm -f ${join(f.initDir, 'vibeterm')}`,
      `sudo -n rm -f ${join(f.sudoersDir, 'vibeterm-vibeterm')}`,
    ]);
    expect(f.running.has('vibeterm')).toBe(false);
  });

  test('uninstall without sudo reports the manual commands', async () => {
    const f = await fixture({ euid: 0 });
    await installOpenrcService(INSTALL, f.deps);
    const run = (async () => NEEDS_PASSWORD) as ServiceDeps['run'];
    const denied = { ...f.deps, euid: 1000, run };
    const error = await uninstallOpenrcService('vibeterm', denied).catch((err) => err);
    expect(String(error.message)).toContain('rc-update del vibeterm default');
  });

  test('uninstall of a missing script is a no-op', async () => {
    const f = await fixture();
    await uninstallOpenrcService('vibeterm', f.deps);
    expect(f.calls).toEqual([]);
  });

  test('stop includes the legacy name only when its script exists', async () => {
    const f = await fixture({ euid: 0 });
    await stopOpenrcService('vibeterm', { legacyServiceName: 'tmex', deps: f.deps });
    expect(f.calls).toEqual(['/sbin/rc-service vibeterm stop']);
    await writeFile(join(f.initDir, 'tmex'), '#!/sbin/openrc-run\n');
    f.calls.length = 0;
    await stopOpenrcService('vibeterm', { legacyServiceName: 'tmex', deps: f.deps });
    expect(f.calls).toEqual(['/sbin/rc-service vibeterm stop', '/sbin/rc-service tmex stop']);
  });

  test('restart starts a stopped service', async () => {
    const f = await fixture({ euid: 0 });
    await restartOpenrcService('vibeterm', f.deps);
    expect(f.calls).toEqual([
      '/sbin/rc-service vibeterm status',
      '/sbin/rc-service vibeterm start',
    ]);
  });

  test('status reflects script, rc-service status and the default runlevel', async () => {
    const f = await fixture({ euid: 0 });
    expect(await queryOpenrcStatus('vibeterm', f.deps)).toEqual({
      manager: 'openrc',
      installed: false,
      running: false,
      autostartEnabled: false,
      detail: undefined,
    });
    await installOpenrcService(INSTALL, f.deps);
    expect(await queryOpenrcStatus('vibeterm', f.deps)).toEqual({
      manager: 'openrc',
      installed: true,
      running: true,
      autostartEnabled: true,
      detail: '* status: started',
    });
  });
});
