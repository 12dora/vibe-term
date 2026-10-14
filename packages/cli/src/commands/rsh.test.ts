import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliContext } from '../core/context';
import { AuthError, InterruptError, NetworkError, NotFoundError, UsageError } from '../core/errors';
import type { ExecChannelResult } from '../core/exec-channel-result';
import type { RemoteRunOptions } from '../core/remote-run';
import { runCli } from '../main';
import { routeFetch, testContext } from './cli-test-harness';
import { command, preprocessRshArgv, remoteRunOptions, rshDeps } from './rsh';

type Call = { ctx: CliContext; opts: RemoteRunOptions };

const originalRunRemote = rshDeps.runRemote;

function result(partial: Partial<ExecChannelResult> = {}): ExecChannelResult {
  return {
    exitCode: 0,
    signal: null,
    reason: 'exit',
    durationMs: 5,
    device: { id: 'dev1', name: 'box', type: 'local' },
    ...partial,
  };
}

function fakeRemote(outcome: ExecChannelResult | Error = result()): { calls: Call[] } {
  const calls: Call[] = [];
  rshDeps.runRemote = (async (ctx: CliContext, opts: RemoteRunOptions) => {
    calls.push({ ctx, opts });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }) as typeof rshDeps.runRemote;
  return { calls };
}

afterEach(() => {
  rshDeps.runRemote = originalRunRemote;
});

describe('preprocessRshArgv', () => {
  test('everything becomes one opaque payload behind --', () => {
    expect(preprocessRshArgv(['-o', 'SendEnv=X', 'host', 'ls'])).toEqual([
      '--',
      '-o',
      'SendEnv=X',
      'host',
      'ls',
    ]);
    expect(preprocessRshArgv([])).toEqual(['--']);
  });

  test('leading vibeterm global flags stay outside the payload', () => {
    expect(preprocessRshArgv(['--entry', 'http://x:1', '--json', 'host', 'ls'])).toEqual([
      '--entry',
      'http://x:1',
      '--json',
      '--',
      'host',
      'ls',
    ]);
    expect(preprocessRshArgv(['--node=a', '-h'])).toEqual(['--node=a', '-h', '--']);
  });

  test('flags after the destination are never taken for globals', () => {
    expect(preprocessRshArgv(['host', '--json'])).toEqual(['--', 'host', '--json']);
    expect(preprocessRshArgv(['--server', 'x'])).toEqual(['--', '--server', 'x']);
  });
});

describe('remoteRunOptions', () => {
  test('maps an invocation without extras', () => {
    expect(
      remoteRunOptions({
        target: 'office/box',
        user: 'root',
        command: { kind: 'shell', script: 'uptime' },
        tty: 'auto',
        stdin: 'auto',
        quiet: false,
        verbose: 0,
        env: {},
      })
    ).toEqual({
      target: 'office/box',
      command: { kind: 'shell', script: 'uptime' },
      tty: 'auto',
      stdin: 'auto',
      verbose: false,
      legacyFallback: true,
    });
  });

  test('carries env, tty, stdin and verbose', () => {
    expect(
      remoteRunOptions({
        target: 'node',
        user: null,
        command: { kind: 'login' },
        tty: 'always',
        stdin: 'none',
        quiet: false,
        verbose: 2,
        env: { A: '1' },
      })
    ).toMatchObject({ tty: 'always', stdin: 'none', verbose: true, env: { A: '1' } });
  });
});

describe('rsh command.run', () => {
  async function run(args: string[], outcome?: ExecChannelResult | Error) {
    const remote = fakeRemote(outcome);
    const { ctx, stderr, stdout } = await testContext(routeFetch({}));
    const code = await command.run(ctx, preprocessRshArgv(args));
    return { code, calls: remote.calls, stderr: stderr.text(), stdout: stdout.text(), ctx };
  }

  test('calls runRemote with the mapped options and passes the exit code through', async () => {
    const { code, calls, stderr } = await run(['node', 'exit', '7'], result({ exitCode: 7 }));
    expect(code).toBe(7);
    expect(stderr).toBe('');
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toEqual({
      target: 'node',
      command: { kind: 'shell', script: 'exit 7' },
      tty: 'auto',
      stdin: 'auto',
      verbose: false,
      legacyFallback: true,
    });
  });

  test('signal exits map to 128+n, timeouts to 124', async () => {
    const term = result({ exitCode: null, signal: 'SIGTERM' });
    const kill = result({ exitCode: null, signal: 'SIGKILL' });
    const timeout = result({ exitCode: null, reason: 'timeout' });
    expect((await run(['node', 'x'], term)).code).toBe(143);
    expect((await run(['node', 'x'], kill)).code).toBe(137);
    expect((await run(['node', 'x'], timeout)).code).toBe(124);
  });

  test('every vibeterm-side failure becomes `vibeterm rsh: …` and exit 255', async () => {
    const failures = [
      new NetworkError('connection refused', 'check the entry'),
      new AuthError('login required', 'vibeterm login'),
      new NotFoundError('device nope not found'),
      new Error('boom'),
    ];
    for (const error of failures) {
      const { code, stderr, stdout } = await run(['node', 'true'], error);
      expect(code).toBe(255);
      expect(stdout).toBe('');
      expect(stderr).toContain(`vibeterm rsh: ${error.message}`);
    }
  });

  test('only auth errors print a hint; other hints are dropped', async () => {
    const network = await run(['node', 'true'], new NetworkError('refused', 'check the entry'));
    expect(network.stderr).toBe('vibeterm rsh: refused\n');
    const missing = await run(['node', 'true'], new NotFoundError('nope', 'try again'));
    expect(missing.stderr).toBe('vibeterm rsh: nope\n');
  });

  test('a hint is printed on its own indented line', async () => {
    const error = new AuthError('login required', 'vibeterm login');
    const { stderr } = await run(['node', 'true'], error);
    expect(stderr).toBe('vibeterm rsh: login required\n  vibeterm login\n');
  });

  test('usage errors exit 255 without calling runRemote', async () => {
    for (const args of [[], ['-L', '1:h:2', 'node'], ['-s', 'node', 'ftp'], ['-Z', 'node']]) {
      const { code, calls, stderr } = await run(args);
      expect(code).toBe(255);
      expect(calls).toHaveLength(0);
      expect(stderr).toStartWith('vibeterm rsh: ');
    }
  });

  test('a UsageError from runRemote is also 255', async () => {
    const { code } = await run(['node', 'true'], new UsageError('bad target'));
    expect(code).toBe(255);
  });

  test('an interrupt keeps its own exit code and prints nothing', async () => {
    const { code, stderr } = await run(['node', 'true'], new InterruptError());
    expect(code).toBe(130);
    expect(stderr).toBe('');
  });

  test('-V prints the version to stderr and does not connect', async () => {
    const { code, calls, stderr, stdout } = await run(['-V']);
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/^vibeterm rsh \S+\n$/);
  });

  test('-v echoes the ignored user and asks for verbose output', async () => {
    const { calls, stderr } = await run(['-v', 'alice@node', 'true']);
    expect(calls[0].opts.verbose).toBe(true);
    expect(stderr).toContain('ignoring user alice');
  });

  test('the user is not mentioned without -v', async () => {
    const { stderr } = await run(['alice@node', 'true']);
    expect(stderr).toBe('');
  });

  test('-q hands runRemote a context that suppresses warnings', async () => {
    const { calls, ctx } = await run(['-q', 'node', 'true']);
    expect(calls[0].ctx.out.quiet).toBe(true);
    expect(calls[0].ctx.globals.quiet).toBe(true);
    expect(ctx.out.quiet).toBe(false);
  });

  test('-q together with -v keeps the context as is', async () => {
    const { calls, ctx } = await run(['-q', '-v', 'node', 'true']);
    expect(calls[0].ctx).toBe(ctx);
  });

  test('tty and stdin flags reach runRemote', async () => {
    const { calls } = await run(['-tt', '-n', 'node']);
    expect(calls[0].opts).toMatchObject({
      command: { kind: 'login' },
      tty: 'always',
      stdin: 'none',
    });
  });

  test('sftp subsystem as scp invokes it', async () => {
    const { calls } = await run(['-x', '-oRequestTTY=no', '-s', '--', 'node/box', 'sftp']);
    expect(calls[0].opts).toMatchObject({
      target: 'node/box',
      command: { kind: 'subsystem', name: 'sftp' },
      tty: 'no',
    });
  });
});

describe('rsh through runCli', () => {
  const ENV_KEYS = [
    'HOME',
    'XDG_CONFIG_HOME',
    'VIBETERM_CLI_HOME',
    'VIBETERM_ENTRY',
    'VIBETERM_SESSION_FILE',
    'VIBETERM_TOKENS_FILE',
    'GIT_PROTOCOL',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};
  const savedConsole = { log: console.log, info: console.info, debug: console.debug };
  const savedWrites = { stdout: process.stdout.write, stderr: process.stderr.write };
  let dir = '';
  let stdoutText = '';
  let stderrText = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vibeterm-rsh-'));
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.HOME = dir;
    process.env.XDG_CONFIG_HOME = join(dir, 'xdg');
    process.env.VIBETERM_CLI_HOME = join(dir, 'cfg');
    process.env.VIBETERM_ENTRY = 'http://entry.example:9883';
    process.env.VIBETERM_SESSION_FILE = join(dir, 'session.json');
    process.env.VIBETERM_TOKENS_FILE = join(dir, 'tokens.json');
    process.env.GIT_PROTOCOL = 'version=2';
    stdoutText = '';
    stderrText = '';
    process.stdout.write = ((chunk: unknown) => {
      stdoutText += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderrText += String(chunk);
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stdout.write = savedWrites.stdout;
    process.stderr.write = savedWrites.stderr;
    console.log = savedConsole.log;
    console.info = savedConsole.info;
    console.debug = savedConsole.debug;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await rm(dir, { recursive: true, force: true });
  });

  test('rsync --server invocation: dashed words survive the generic dispatcher', async () => {
    const { calls } = fakeRemote(result({ exitCode: 0 }));
    const code = await runCli([
      'rsh',
      '-l',
      'alice',
      'node',
      'rsync',
      '--server',
      '-vlogDtpre.iLsfxCIvu',
      '--sender',
      '.',
      '/data/dir/',
    ]);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toMatchObject({
      target: 'node',
      command: {
        kind: 'shell',
        script: 'rsync --server -vlogDtpre.iLsfxCIvu --sender . /data/dir/',
      },
      tty: 'auto',
      stdin: 'auto',
      legacyFallback: true,
    });
    expect(calls[0].ctx.globals.entry).toBe('http://entry.example:9883');
  });

  test('git invocation: SendEnv forwards GIT_PROTOCOL, the command stays intact', async () => {
    const { calls } = fakeRemote();
    const code = await runCli([
      'rsh',
      '-o',
      'SendEnv=GIT_PROTOCOL',
      '-p',
      '22',
      'git@node',
      "git-upload-pack '/srv/repo.git'",
    ]);
    expect(code).toBe(0);
    expect(calls[0].opts).toMatchObject({
      target: 'node',
      command: { kind: 'shell', script: "git-upload-pack '/srv/repo.git'" },
      env: { GIT_PROTOCOL: 'version=2' },
    });
  });

  test('scp -S shape: -s sftp with options before the destination', async () => {
    const { calls } = fakeRemote();
    const code = await runCli([
      'rsh',
      '-x',
      '-oPermitLocalCommand=no',
      '-oClearAllForwardings=yes',
      '-oRemoteCommand=none',
      '-oRequestTTY=no',
      '-oForwardAgent=no',
      '-s',
      '--',
      'node',
      'sftp',
    ]);
    expect(code).toBe(0);
    expect(calls[0].opts).toMatchObject({
      target: 'node',
      command: { kind: 'subsystem', name: 'sftp' },
      tty: 'no',
    });
  });

  test('vibeterm global flags before the command name still configure the context', async () => {
    const { calls } = fakeRemote();
    const code = await runCli(['--entry', 'http://other.example:1', 'rsh', 'node', 'true']);
    expect(code).toBe(0);
    expect(calls[0].ctx.globals.entry).toBe('http://other.example:1');
  });

  test('unknown long options are ssh option errors, not vibeterm flag errors', async () => {
    const { calls } = fakeRemote();
    const code = await runCli(['rsh', '--bogus', 'node']);
    expect(code).toBe(255);
    expect(calls).toHaveLength(0);
    expect(stderrText).toContain('vibeterm rsh: unknown option: --bogus');
  });

  test('failures before the command runs are rsh failures too (255, `vibeterm rsh:`)', async () => {
    const { calls } = fakeRemote();
    expect(await runCli(['--timeout', '0', 'rsh', 'node', 'true'])).toBe(255);
    expect(stderrText).toBe('vibeterm rsh: --timeout must be a positive integer, got 0\n');
    stderrText = '';
    const missing = join(dir, 'missing.pem');
    expect(await runCli(['--ca', missing, 'rsh', 'node', 'true'])).toBe(255);
    expect(stderrText).toStartWith(`vibeterm rsh: --ca cannot read ${missing}`);
    expect(stderrText.trimEnd().split('\n')).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  test('other commands keep the generic prefix and exit code for such failures', async () => {
    stderrText = '';
    expect(await runCli(['--timeout', '0', 'devices'])).toBe(2);
    expect(stderrText).toStartWith('vibeterm: --timeout must be a positive integer');
  });

  test('the help describes where global flags may go', async () => {
    expect(await runCli(['rsh', '--help'])).toBe(0);
    expect(stdoutText).toContain('只能写在 rsh 之前');
    expect(stdoutText).not.toContain('rsh 不接受');
  });

  test('remote exit code passes through, local failures are 255', async () => {
    fakeRemote(result({ exitCode: 1 }));
    expect(await runCli(['rsh', 'node', 'false'])).toBe(1);
    fakeRemote(new NetworkError('gateway unreachable'));
    expect(await runCli(['rsh', 'node', 'true'])).toBe(255);
    expect(stderrText).toContain('vibeterm rsh: gateway unreachable');
  });

  test('-G prints an OpenSSH-style config and does not connect (git variant probe)', async () => {
    const { calls } = fakeRemote();
    expect(await runCli(['rsh', '-G', 'localhost'])).toBe(0);
    expect(calls).toHaveLength(0);
    expect(stdoutText).toMatch(/^user \S+\nhostname localhost\nport 22\n$/);
  });

  test('--help and vibeterm help rsh print the usage on stdout', async () => {
    expect(await runCli(['rsh', '--help'])).toBe(0);
    expect(stdoutText).toContain('vibeterm rsh [选项]');
    expect(stdoutText).toContain("rsync -a -e 'vibeterm rsh'");
    stdoutText = '';
    expect(await runCli(['help', 'rsh'])).toBe(0);
    expect(stdoutText).toContain('vibeterm-rsh');
  });
});
