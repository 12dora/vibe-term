import { afterEach, describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { RunCommandResult } from './process';
import {
  buildOpenrcInitScript,
  buildOpenrcSudoers,
  installOpenrcService,
  openrcControlReady,
  openrcSudoersFileName,
  parseOpenrcOwner,
  parseRunlevelMembership,
  queryOpenrcStatus,
  restartOpenrcService,
  stopOpenrcService,
  uninstallOpenrcService,
} from './service-openrc';
import {
  OpenrcPrivilegeError,
  createPrivilegedRun,
  defaultResolveBin,
  isSudoAuthFailure,
  probeNopasswd,
} from './service-openrc-privilege';
import type { ServiceDeps } from './service-types';

type Run = NonNullable<ServiceDeps['run']>;

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

  test('carries the managed marker and the owning install dir', () => {
    expect(script.startsWith('#!/sbin/openrc-run\n# vibeterm-openrc-service\n')).toBe(true);
    expect(script).toContain('# vibeterm-install-dir: /home/alice/.local/share/vibeterm\n');
    expect(parseOpenrcOwner(script)).toEqual({
      managed: true,
      installDir: '/home/alice/.local/share/vibeterm',
    });
    expect(parseOpenrcOwner('#!/sbin/openrc-run\ncommand=/usr/sbin/sshd\n').managed).toBe(false);
  });

  test('supervise-daemon runs run.sh as the installing user (single-quoted)', () => {
    expect(script).toContain('supervisor=supervise-daemon\n');
    expect(script).toContain("command='/home/alice/.local/share/vibeterm/run.sh'\n");
    expect(script).toContain("command_args=''\n");
    expect(script).toContain("command_user='alice:alice'\n");
    expect(script).toContain("directory='/home/alice/.local/share/vibeterm'\n");
    expect(script).toContain('pidfile="/run/${RC_SVCNAME}.pid"\n');
    expect(script).not.toContain('command_background');
  });

  test('respawns forever and never sweeps the cgroup (tmux survives)', () => {
    expect(script).toContain('respawn_delay=3\n');
    expect(script).toContain('respawn_max=0\n');
    expect(script).toContain("retry='TERM/20/KILL/5'\n");
    expect(script).toContain("rc_cgroup_cleanup='no'\n");
  });

  test('logs to the install dir and exports env with single quotes in start_pre', () => {
    expect(script).toContain("output_log='/home/alice/.local/share/vibeterm/vibeterm.log'\n");
    expect(script).toContain("error_log='/home/alice/.local/share/vibeterm/vibeterm.err.log'\n");
    expect(script).toContain(
      "\texport VIBETERM_LOG_FILE='/home/alice/.local/share/vibeterm/vibeterm.log'\n"
    );
    expect(script).toContain(
      "\texport VIBETERM_LOG_ERR_FILE='/home/alice/.local/share/vibeterm/vibeterm.err.log'\n"
    );
    expect(script).toContain("\texport VIBETERM_SERVICE_MANAGER='openrc'\n");
    expect(script).toContain("\texport HOME='/home/alice'\n");
    expect(script).toContain("\texport USER='alice'\n");
    expect(script).toContain("\texport LOGNAME='alice'\n");
  });

  test('wants (not needs) net so boot never blocks on a missing net provider', () => {
    expect(script).toContain('depend() {\n\twant net\n\tafter firewall\n}\n');
    expect(script).not.toContain('need net');
  });

  test('omits the group when unknown', () => {
    const noGroup = buildOpenrcInitScript({ ...SCRIPT_OPTIONS, group: undefined });
    expect(noGroup).toContain("command_user='alice'\n");
  });

  // supervise-daemon.sh 以 root 二次 eval 这些值：引号挡不住，只能拒绝。
  const unsafe = [
    ['installDir', '/home/alice/my vt'],
    ['installDir', '/srv/x;touch /pwn'],
    ['installDir', '/srv/$(id)'],
    ['installDir', '/srv/`id`'],
    ['installDir', "/srv/a'b"],
    ['installDir', '/srv/a"b'],
    ['installDir', '/srv/*'],
    ['installDir', '/srv/a|b'],
    ['installDir', '/srv/a&b'],
    ['installDir', '/srv/a>b'],
    ['installDir', 'relative/dir'],
    ['runScriptPath', '/srv/vt/run.sh;id'],
    ['homeDir', '/home/al ice'],
    ['group', 'staff;id'],
    ['user', 'al ice'],
  ] as const;
  for (const [field, value] of unsafe) {
    test(`rejects unsafe ${field}: ${JSON.stringify(value)}`, () => {
      expect(() => buildOpenrcInitScript({ ...SCRIPT_OPTIONS, [field]: value })).toThrow();
    });
  }

  test('unsafe path error names the path', () => {
    expect(() => buildOpenrcInitScript({ ...SCRIPT_OPTIONS, installDir: '/a b' })).toThrow('/a b');
  });
});

describe('sudoers rule', () => {
  test('only allows rc-service actions on this service', () => {
    const rule = buildOpenrcSudoers('alice', 'vibeterm', '/sbin/rc-service');
    expect(rule).toContain(
      'alice ALL=(root) NOPASSWD: /sbin/rc-service vibeterm start, /sbin/rc-service vibeterm stop, /sbin/rc-service vibeterm restart, /sbin/rc-service vibeterm status\n'
    );
  });

  test('refuses a command path that would break or widen the rule', () => {
    expect(() => buildOpenrcSudoers('alice', 'vibeterm', '/home/a b/rc-service')).toThrow();
    expect(() => buildOpenrcSudoers('alice', 'vibeterm', '/sbin/rc-*')).toThrow();
    expect(() => buildOpenrcSudoers('alice', 'vibeterm', '/sbin/rc-service,ALL')).toThrow();
  });

  test('file name has no dot (sudo skips such files)', () => {
    expect(openrcSudoersFileName('vibe.term')).toBe('vibeterm-vibe_term');
  });
});

describe('defaultResolveBin', () => {
  test('never resolves through the user PATH', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-fake-path-'));
    const name = `vibeterm-fake-bin-${Date.now()}`;
    await writeFile(join(dir, name), '#!/bin/sh\n', { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${dir}:${savedPath ?? ''}`;
    try {
      expect(defaultResolveBin(name)).toBe(`/sbin/${name}`);
    } finally {
      process.env.PATH = savedPath;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('parseRunlevelMembership', () => {
  const output = '            sshd | default\n        vibeterm | default\n   vibeterm2 | default\n';
  test('matches the exact service name', () => {
    expect(parseRunlevelMembership(output, 'vibeterm')).toBe(true);
    expect(parseRunlevelMembership(output, 'vibe')).toBe(false);
  });
});

describe('isSudoAuthFailure', () => {
  const cases = [
    'sudo: a password is required',
    'sudo: a terminal is required to read the password; either use the -S option',
    'sudo-rs: interactive authentication is required',
    'sudo-rs: A terminal is required to authenticate',
    "sudo-rs: I'm sorry alice. I'm afraid I can't do that",
    'Sorry, user alice is not allowed to execute rc-service as root.',
  ];
  for (const stderr of cases) {
    test(`recognises ${JSON.stringify(stderr)}`, () => {
      expect(isSudoAuthFailure(fail(stderr))).toBe(true);
    });
  }
  test('a plain command failure is not an auth failure', () => {
    expect(isSudoAuthFailure(fail(' * ERROR: vibeterm failed to start'))).toBe(false);
    expect(isSudoAuthFailure(fail(' * status: stopped', 3))).toBe(false);
  });
});

/**
 * sudo 模型：
 * - cached：交互输过密码，`sudo -n` 一律放行；`-k` 只认 sudoers 白名单（规则文件存在时）
 * - rule：只有白名单 rc-service 命令免密（规则文件存在时），其余要密码（网页升级的真实情况）
 * - password：一律要密码；missing：没有 sudo
 */
type SudoMode = 'cached' | 'rule' | 'password' | 'missing';

let roots: string[] = [];

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots = [];
});

interface FixtureOptions {
  euid?: number;
  sudo?: SudoMode;
  interactive?: boolean;
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vibeterm-openrc-test-'));
  roots.push(root);
  const initDir = join(root, 'init.d');
  const sudoersDir = join(root, 'sudoers.d');
  const installDir = join(root, 'install');
  await mkdir(initDir, { recursive: true });
  await mkdir(sudoersDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  const calls: string[] = [];
  const sudoEnvs: (string | undefined)[] = [];
  const warns: string[] = [];
  const runlevel = new Set<string>();
  const running = new Set<string>();
  const ruleFile = join(sudoersDir, 'vibeterm-vibeterm');

  const builtin = async (argv: string[]): Promise<RunCommandResult> => {
    const [cmd, ...args] = argv;
    const name = basename(cmd);
    if (name === 'install') {
      await copyFile(args[2], args[3]);
      return ok();
    }
    if (name === 'rm') {
      for (const path of args.slice(1)) await rm(path, { force: true });
      return ok();
    }
    if (name === 'rc-update' && args[0] === 'show') {
      return ok([...runlevel].map((svc) => `  ${svc} | default`).join('\n'));
    }
    if (name === 'rc-update') {
      if (args[0] === 'add') runlevel.add(args[1]);
      else runlevel.delete(args[1]);
      return ok();
    }
    if (name === 'rc-service') {
      const [svc, action] = args;
      if (action === 'status')
        return running.has(svc) ? ok(' * status: started') : fail(' * status: stopped', 3);
      if (action === 'stop') running.delete(svc);
      else running.add(svc);
      return ok();
    }
    return ok();
  };

  const ruleAllows = async (argv: string[]) => {
    const exists = await readFile(ruleFile, 'utf8').then(
      () => true,
      () => false
    );
    return exists && argv[0] === '/sbin/rc-service';
  };

  const state = { sudo: options.sudo ?? 'cached' };
  const sudo = async (args: string[]): Promise<RunCommandResult> => {
    const mode = state.sudo;
    if (mode === 'missing') throw new Error('spawn sudo ENOENT');
    if (args[0] === '-v') return mode === 'password' ? NEEDS_PASSWORD : ok();
    const ignoreCache = args[1] === '-k';
    const argv = args.slice(ignoreCache ? 2 : 1);
    if (await ruleAllows(argv)) return builtin(argv);
    if (mode === 'cached' && !ignoreCache) return builtin(argv);
    return NEEDS_PASSWORD;
  };

  const run = (async (command: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    calls.push([command, ...args].join(' '));
    if (command === 'sudo') {
      sudoEnvs.push(opts?.env?.LC_ALL);
      return sudo(args);
    }
    return builtin([command, ...args]);
  }) as Run;

  const deps: ServiceDeps = {
    run,
    euid: options.euid ?? 1000,
    isInteractive: () => options.interactive ?? false,
    resolveBin: (name) => (name.startsWith('rc-') ? `/sbin/${name}` : `/bin/${name}`),
    openrcInitDir: initDir,
    sudoersDir,
    username: 'alice',
    groupName: 'alice',
    homeDir: '/home/alice',
    log: () => undefined,
    warn: (line) => warns.push(line),
  };
  const install = {
    serviceName: 'vibeterm',
    runScriptPath: join(installDir, 'run.sh'),
    installDir,
    autostart: true,
  };
  const scriptPath = join(initDir, 'vibeterm');
  const setSudo = (mode: SudoMode) => {
    state.sudo = mode;
  };
  return {
    setSudo,
    root,
    initDir,
    sudoersDir,
    installDir,
    scriptPath,
    ruleFile,
    calls,
    sudoEnvs,
    warns,
    deps,
    install,
    runlevel,
    running,
  };
}

const stripStaged = (calls: string[]) =>
  calls.map((call) => call.replace(/\S*vibeterm-openrc-[^/\s]+\/staged/g, '<staged>'));

describe('installOpenrcService', () => {
  test('root: writes the script and controls the service without sudo', async () => {
    const f = await fixture({ euid: 0 });
    await installOpenrcService(f.install, f.deps);

    expect(await readFile(f.scriptPath, 'utf8')).toContain("command_user='alice:alice'");
    expect(stripStaged(f.calls)).toEqual([
      `/bin/install -m 0755 <staged> ${f.scriptPath}`,
      '/sbin/rc-update show default',
      '/sbin/rc-update add vibeterm default',
      '/sbin/rc-service vibeterm status',
      '/sbin/rc-service vibeterm start',
    ]);
    expect(f.calls.some((call) => call.startsWith('sudo'))).toBe(false);
  });

  test('non-root interactive install: probes before escalating, then writes the rule', async () => {
    const f = await fixture();
    await installOpenrcService(f.install, f.deps);

    expect(stripStaged(f.calls)).toEqual([
      'sudo -n -k /sbin/rc-service vibeterm status',
      `sudo -n /bin/install -m 0755 <staged> ${f.scriptPath}`,
      'sudo -n /bin/visudo -cf <staged>',
      `sudo -n /bin/install -m 0440 <staged> ${f.ruleFile}`,
      '/sbin/rc-update show default',
      'sudo -n /sbin/rc-update add vibeterm default',
      '/sbin/rc-service vibeterm status',
      'sudo -n /sbin/rc-service vibeterm start',
    ]);
    expect(await readFile(f.ruleFile, 'utf8')).toContain('alice ALL=(root) NOPASSWD:');
    expect(f.sudoEnvs.every((lc) => lc === 'C')).toBe(true);
  });

  test('web upgrade (no TTY, rule only, same script): only rc-service is used', async () => {
    const f = await fixture();
    await installOpenrcService(f.install, f.deps);
    f.calls.length = 0;
    f.setSudo('rule');
    await installOpenrcService(f.install, f.deps);

    expect(f.calls).toEqual([
      'sudo -n -k /sbin/rc-service vibeterm status',
      '/sbin/rc-update show default',
      '/sbin/rc-service vibeterm status',
      'sudo -n /sbin/rc-service vibeterm restart',
    ]);
    expect(f.warns).toEqual([]);
  });

  test('web upgrade with a changed script and no full sudo: warns, still restarts', async () => {
    const f = await fixture();
    await installOpenrcService(f.install, f.deps);
    await writeFile(f.scriptPath, `${await readFile(f.scriptPath, 'utf8')}# older template\n`);
    f.calls.length = 0;
    f.setSudo('rule');
    await installOpenrcService(f.install, f.deps);

    expect(f.warns).toHaveLength(1);
    expect(f.warns[0]).toContain('not refreshed');
    expect(f.calls.at(-1)).toBe('sudo -n /sbin/rc-service vibeterm restart');
    expect(f.running.has('vibeterm')).toBe(true);
  });

  test('fresh install without sudo and no TTY: clear privilege error', async () => {
    const f = await fixture({ sudo: 'password' });
    const error = await installOpenrcService(f.install, f.deps).catch((err) => err);
    expect(error).toBeInstanceOf(OpenrcPrivilegeError);
    expect(String(error.message)).toContain('--no-service');
    expect(f.calls.some((call) => call === 'sudo -v')).toBe(false);
  });

  test('sudo missing entirely: same clear error', async () => {
    const f = await fixture({ sudo: 'missing' });
    const error = await installOpenrcService(f.install, f.deps).catch((err) => err);
    expect(error).toBeInstanceOf(OpenrcPrivilegeError);
  });

  test('refuses to overwrite a script VibeTerm did not write', async () => {
    const f = await fixture({ euid: 0 });
    await writeFile(f.scriptPath, '#!/sbin/openrc-run\ncommand=/usr/sbin/sshd\n');
    const error = await installOpenrcService(f.install, f.deps).catch((err) => err);
    expect(String(error.message)).toContain(f.scriptPath);
    expect(f.calls).toEqual([]);
    expect(await readFile(f.scriptPath, 'utf8')).toContain('sshd');
  });

  test('refuses a script owned by another existing install unless forced', async () => {
    const f = await fixture({ euid: 0 });
    const other = join(f.root, 'other');
    await mkdir(other);
    const foreign = buildOpenrcInitScript({
      ...SCRIPT_OPTIONS,
      installDir: other,
      runScriptPath: join(other, 'run.sh'),
    });
    await writeFile(f.scriptPath, foreign);
    const error = await installOpenrcService(f.install, f.deps).catch((err) => err);
    expect(String(error.message)).toContain(other);
    expect(f.calls).toEqual([]);

    await installOpenrcService({ ...f.install, force: true }, f.deps);
    expect(parseOpenrcOwner(await readFile(f.scriptPath, 'utf8')).installDir).toBe(f.installDir);
  });

  test('takes over a script whose owning install dir is gone', async () => {
    const f = await fixture({ euid: 0 });
    const gone = join(f.root, 'gone');
    const owned = { ...SCRIPT_OPTIONS, installDir: gone, runScriptPath: `${gone}/run.sh` };
    await writeFile(f.scriptPath, buildOpenrcInitScript(owned));
    await installOpenrcService(f.install, f.deps);
    expect(parseOpenrcOwner(await readFile(f.scriptPath, 'utf8')).installDir).toBe(f.installDir);
  });

  test('rejects an install dir with shell metacharacters before any privileged step', async () => {
    const f = await fixture({ euid: 0 });
    const error = await installOpenrcService(
      { ...f.install, installDir: '/srv/x;id', runScriptPath: '/srv/x;id/run.sh' },
      f.deps
    ).catch((err) => err);
    expect(String(error.message)).toContain('/srv/x;id');
    expect(f.calls).toEqual([]);
  });

  test('autostart=false removes the service from the default runlevel', async () => {
    const f = await fixture({ euid: 0 });
    f.runlevel.add('vibeterm');
    await installOpenrcService({ ...f.install, autostart: false }, f.deps);
    expect(f.calls).toContain('/sbin/rc-update del vibeterm default');
    expect(f.runlevel.has('vibeterm')).toBe(false);
  });

  test('rejects unsafe service names before touching anything', async () => {
    const f = await fixture({ euid: 0 });
    const evil = { ...f.install, serviceName: '../evil' };
    const error = await installOpenrcService(evil, f.deps).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(f.calls).toEqual([]);
  });

  test('legacy name: removed only when its managed script exists', async () => {
    const f = await fixture({ euid: 0 });
    await installOpenrcService({ ...f.install, legacyServiceName: 'tmex' }, f.deps);
    expect(f.calls.some((call) => call.includes('tmex'))).toBe(false);

    const legacy = join(f.initDir, 'tmex');
    const legacyOptions = { ...SCRIPT_OPTIONS, ...f.install, serviceName: 'tmex' };
    await writeFile(legacy, buildOpenrcInitScript(legacyOptions));
    f.runlevel.add('tmex');
    f.calls.length = 0;
    await installOpenrcService({ ...f.install, legacyServiceName: 'tmex' }, f.deps);
    expect(f.calls.slice(0, 4)).toEqual([
      '/sbin/rc-service tmex stop',
      '/sbin/rc-update show default',
      '/sbin/rc-update del tmex default',
      `/bin/rm -f ${legacy}`,
    ]);
  });
});

describe('openrcControlReady', () => {
  test('root is always ready', async () => {
    const f = await fixture({ euid: 0, sudo: 'password' });
    expect(await openrcControlReady('vibeterm', f.deps)).toBe(true);
    expect(f.calls).toEqual([]);
  });

  test('non-root: ready only with the NOPASSWD rule, cached credentials do not count', async () => {
    const f = await fixture();
    expect(await openrcControlReady('vibeterm', f.deps)).toBe(false);
    await writeFile(f.ruleFile, 'rule');
    expect(await openrcControlReady('vibeterm', f.deps)).toBe(true);
    expect(f.calls).toEqual([
      'sudo -n -k /sbin/rc-service vibeterm status',
      'sudo -n -k /sbin/rc-service vibeterm status',
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
    }) as Run;
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

  test('sudo -n runs with LC_ALL=C / LANG=C so the auth check is locale-proof', async () => {
    const envs: (NodeJS.ProcessEnv | undefined)[] = [];
    const run = (async (_command: string, _args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      envs.push(opts?.env);
      return ok();
    }) as Run;
    await createPrivilegedRun({ run, euid: 1000 })(['/sbin/rc-service', 'vibeterm', 'stop']);
    expect(envs[0]?.LC_ALL).toBe('C');
    expect(envs[0]?.LANG).toBe('C');
  });

  test('sudo-rs auth failure also triggers the interactive fallback', async () => {
    let validated = false;
    const run = (async (_command: string, args: string[]) => {
      if (args[0] === '-v') {
        validated = true;
        return ok();
      }
      return validated ? ok() : fail('sudo-rs: interactive authentication is required');
    }) as Run;
    const privileged = createPrivilegedRun({ run, euid: 1000, isInteractive: () => true });
    expect((await privileged(['/bin/rm', '-f', '/x'])).code).toBe(0);
    expect(validated).toBe(true);
  });

  test('a failing command (not a sudo auth error) is returned, not escalated', async () => {
    const run = (async () => fail(' * ERROR: vibeterm failed')) as Run;
    const privileged = createPrivilegedRun({ run, euid: 1000, isInteractive: () => true });
    const result = await privileged(['/sbin/rc-service', 'vibeterm', 'start']);
    expect(result.code).toBe(1);
  });

  test('denied after validation → privilege error', async () => {
    const denied = fail('Sorry, user alice is not allowed to execute rc-service');
    const run = (async (_command: string, args: string[]) =>
      args[0] === '-v' ? ok() : denied) as Run;
    const privileged = createPrivilegedRun({ run, euid: 1000, isInteractive: () => true });
    await expect(privileged(['/bin/rm', '-f', '/etc/init.d/x'])).rejects.toBeInstanceOf(
      OpenrcPrivilegeError
    );
  });
});

describe('uninstallOpenrcService', () => {
  test('stops, disables, then removes the rule before the script', async () => {
    const f = await fixture();
    await installOpenrcService(f.install, f.deps);
    f.calls.length = 0;
    await uninstallOpenrcService('vibeterm', f.installDir, f.deps);
    expect(f.calls).toEqual([
      'sudo -n /sbin/rc-service vibeterm stop',
      '/sbin/rc-update show default',
      'sudo -n /sbin/rc-update del vibeterm default',
      `sudo -n /bin/rm -f ${f.ruleFile}`,
      `sudo -n /bin/rm -f ${f.scriptPath}`,
    ]);
    expect(f.running.has('vibeterm')).toBe(false);
  });

  test('root removes a user-installed rule even when the script is already gone', async () => {
    const f = await fixture({ euid: 0 });
    await writeFile(f.ruleFile, 'rule');
    f.runlevel.add('vibeterm');
    await uninstallOpenrcService('vibeterm', f.installDir, f.deps);
    expect(f.calls).toEqual([
      '/sbin/rc-update show default',
      '/sbin/rc-update del vibeterm default',
      `/bin/rm -f ${f.ruleFile}`,
    ]);
    expect(f.runlevel.has('vibeterm')).toBe(false);
  });

  test('non-root with nothing left: no sudo prompt', async () => {
    const f = await fixture({ sudo: 'password' });
    await uninstallOpenrcService('vibeterm', f.installDir, f.deps);
    expect(f.calls).toEqual([
      '/sbin/rc-update show default',
      'sudo -n -k /sbin/rc-service vibeterm status',
    ]);
  });

  test('refuses to remove a script VibeTerm did not write', async () => {
    const f = await fixture({ euid: 0 });
    await writeFile(f.scriptPath, '#!/sbin/openrc-run\ncommand=/usr/sbin/sshd\n');
    const error = await uninstallOpenrcService('vibeterm', f.installDir, f.deps).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(f.calls).toEqual([]);
    expect(await readFile(f.scriptPath, 'utf8')).toContain('sshd');
  });

  test('without sudo it reports the manual commands', async () => {
    const f = await fixture({ euid: 0 });
    await installOpenrcService(f.install, f.deps);
    const denied = { ...f.deps, euid: 1000, run: (async () => NEEDS_PASSWORD) as Run };
    const error = await uninstallOpenrcService('vibeterm', f.installDir, denied).catch((e) => e);
    expect(String(error.message)).toContain('rc-update del vibeterm default');
  });
});

describe('stop / restart / status', () => {
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
    await installOpenrcService(f.install, f.deps);
    expect(await queryOpenrcStatus('vibeterm', f.deps)).toEqual({
      manager: 'openrc',
      installed: true,
      running: true,
      autostartEnabled: true,
      detail: '* status: started',
    });
  });
});

describe('probeNopasswd', () => {
  const runWith = (result: RunCommandResult) => (async () => result) as unknown as Run;

  test('rejects sudo refusals that are not password prompts', async () => {
    const refused = fail('alice is not in the sudoers file.  This incident will be reported.');
    expect(await probeNopasswd(runWith(refused), ['/sbin/rc-service', 'vibeterm', 'status'])).toBe(
      false
    );
    expect(await probeNopasswd(runWith(fail('')), ['/sbin/rc-service', 'vibeterm', 'status'])).toBe(
      false
    );
  });

  test('accepts rc-service output, including a stopped service', async () => {
    const stopped = fail(' * status: stopped', 3);
    expect(await probeNopasswd(runWith(stopped), ['/sbin/rc-service', 'vibeterm', 'status'])).toBe(
      true
    );
  });
});
