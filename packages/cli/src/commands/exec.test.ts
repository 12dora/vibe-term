import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EcKind } from '@vibeterm/shared/exec-channel';
import { GLOBAL_FLAGS, splitGlobalFlags } from '../core/args';
import type { CliContext } from '../core/context';
import { AuthError, NetworkError, UsageError } from '../core/errors';
import type { ExecChannelResult } from '../core/exec-channel';
import {
  EXIT_OK,
  FAST,
  type ServerConn,
  fakeLink,
  onHello,
  readyOf,
  textBytes,
} from '../core/exec-channel-fakes';
import { EXEC_STREAM_CLOSED, ExecStreamClosedError } from '../core/exec-client';
import { type RemoteRunOptions, runRemote } from '../core/remote-run';
import {
  type FakeTerminalOptions,
  LEGACY_DEVICE,
  LEGACY_EXIT,
  fakeTerminal,
  ndjsonResponse,
} from '../core/remote-run-fakes';
import { jsonResponse, testContext } from './cli-test-harness';
import { type ExecDeps, buildExecCommand } from './exec';
import type { Command } from './types';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const notFoundFetch = async () => jsonResponse({ error: 'Not found' }, 404);

/** 和 dispatch 一样：先 preprocessArgv，再摘掉全局旗标，最后交给 run。 */
function runExec(command: Command, ctx: CliContext, argv: string[]): Promise<number | undefined> {
  const rewritten = command.preprocessArgv?.(argv) ?? argv;
  const { rest } = splitGlobalFlags(rewritten, { ...GLOBAL_FLAGS, ...command.flags });
  return command.run(ctx, rest);
}

function fakeRun(
  script?: (options: RemoteRunOptions) => Promise<void> | void,
  result: Partial<ExecChannelResult> = {}
) {
  const calls: RemoteRunOptions[] = [];
  const deps: ExecDeps = {
    run: async (_ctx, options) => {
      calls.push(options);
      await script?.(options);
      return {
        exitCode: 0,
        signal: null,
        reason: 'exit',
        durationMs: 12,
        device: { id: 'dev-1', name: 'box', type: 'local' },
        ...result,
      };
    },
  };
  return { calls, command: buildExecCommand(deps) };
}

describe('exec argv preprocessing', () => {
  const { command } = fakeRun();
  const rewrite = (argv: string[]) => command.preprocessArgv?.(argv);
  const table: Array<[string, string[], string[]]> = [
    ['command after the target', ['box', 'ls', '-la'], ['box', '--', 'ls', '-la']],
    [
      'command flags pass through verbatim',
      ['box', 'ls', '--all', '-la'],
      ['box', '--', 'ls', '--all', '-la'],
    ],
    ['no command', ['box'], ['box']],
    ['-t before the target', ['-t', 'box', 'top'], ['box', '--tty', '--', 'top']],
    ['-t after the target', ['box', '-t', 'top'], ['box', '--tty', '--', 'top']],
    ['-tt is always-pty', ['-tt', 'box'], ['box', '--force-tty']],
    ['repeated -t', ['-t', '-t', 'box'], ['box', '--force-tty']],
    ['repeated --tty', ['--tty', '--tty', 'box'], ['box', '--force-tty']],
    ['-T', ['-T', 'box', 'x'], ['--no-tty', 'box', '--', 'x']],
    ['clusters', ['-nT', 'box'], ['--no-stdin', '--no-tty', 'box']],
    ['-v and -q', ['-v', 'box', '-q', 'ls'], ['--verbose', 'box', '--quiet', '--', 'ls']],
    [
      'valued option before the target',
      ['--cwd', '/tmp', 'box', 'pwd'],
      ['--cwd', '/tmp', 'box', '--', 'pwd'],
    ],
    [
      'valued global option',
      ['--timeout', '5000', 'box', 'sleep', '1'],
      ['--timeout', '5000', 'box', '--', 'sleep', '1'],
    ],
    ['equals form', ['--env=A=1', 'box', 'env'], ['--env=A=1', 'box', '--', 'env']],
    ['json flag', ['--json', 'box', 'ls'], ['--json', 'box', '--', 'ls']],
    [
      'explicit -- means exact argv',
      ['box', '--', 'echo', '-n', 'hi'],
      ['box', '--argv', '--', 'echo', '-n', 'hi'],
    ],
    [
      'legacy --shell --',
      ['box', '--shell', '--', 'cat | wc'],
      ['box', '--shell', '--argv', '--', 'cat | wc'],
    ],
    [
      'legacy option before -- ',
      ['box', '--cwd', '/tmp', '--', 'pwd'],
      ['box', '--cwd', '/tmp', '--argv', '--', 'pwd'],
    ],
    [
      '@path right after the target',
      ['box', '@in.txt', 'cat'],
      ['box', '--stdin-file=in.txt', '--', 'cat'],
    ],
    ['@path inside the command is verbatim', ['box', 'echo', '@x'], ['box', '--', 'echo', '@x']],
    ['help flag', ['box', '-h'], ['box', '-h']],
  ];
  for (const [name, input, expected] of table) {
    test(name, () => expect(rewrite(input)).toEqual(expected));
  }

  test('an unknown short option before the command is a usage error', () => {
    expect(() => rewrite(['-x', 'box'])).toThrow(UsageError);
    expect(() => rewrite(['box', '-la', 'ls'])).toThrow(UsageError);
  });
});

describe('vibeterm exec option mapping', () => {
  test('words after the target are joined into one shell script', async () => {
    const { ctx } = await testContext(notFoundFetch);
    const { calls, command } = fakeRun();
    const code = await runExec(command, ctx, ['box', 'ls', '-la', '/tmp']);
    expect(code).toBe(0);
    expect(calls[0]).toMatchObject({
      target: 'box',
      command: { kind: 'shell', script: 'ls -la /tmp' },
      tty: 'auto',
      stdin: 'auto',
      verbose: false,
      legacyFallback: true,
    });
    expect(calls[0]).not.toHaveProperty('node');
    expect(calls[0]?.timeoutMs).toBeUndefined();
    expect(calls[0]?.command).not.toHaveProperty('sh');
  });

  test('a single quoted word is the script as-is', async () => {
    const { ctx } = await testContext(notFoundFetch);
    const { calls, command } = fakeRun();
    await runExec(command, ctx, ['box', 'ls | wc -l']);
    expect(calls[0]?.command).toEqual({ kind: 'shell', script: 'ls | wc -l' });
  });

  test('no command is a login shell', async () => {
    const { ctx } = await testContext(notFoundFetch);
    const { calls, command } = fakeRun();
    await runExec(command, ctx, ['box']);
    expect(calls[0]?.command).toEqual({ kind: 'login' });
  });

  test('an explicit -- keeps the exact argv', async () => {
    const { ctx } = await testContext(notFoundFetch);
    const { calls, command } = fakeRun();
    await runExec(command, ctx, ['box', '--', 'echo', 'a b']);
    expect(calls[0]?.command).toEqual({ kind: 'argv', argv: ['echo', 'a b'] });
  });

  test('--sh selects /bin/sh; legacy --shell -- takes exactly one script', async () => {
    const { ctx } = await testContext(notFoundFetch);
    const { calls, command } = fakeRun();
    await runExec(command, ctx, ['--sh', 'box', 'echo', 'x']);
    expect(calls[0]?.command).toEqual({ kind: 'shell', script: 'echo x', sh: true });
    await runExec(command, ctx, ['box', '--shell', '--', 'cat | wc']);
    expect(calls[1]?.command).toEqual({ kind: 'shell', script: 'cat | wc', sh: true });
    await expect(
      runExec(command, ctx, ['box', '--shell', '--', 'echo', 'a'])
    ).rejects.toBeInstanceOf(UsageError);
  });

  test('tty flags map to ssh -t / -tt / -T and cannot be mixed', async () => {
    const { ctx } = await testContext(notFoundFetch);
    const { calls, command } = fakeRun();
    await runExec(command, ctx, ['-t', 'box', 'top']);
    await runExec(command, ctx, ['-tt', 'box', 'top']);
    await runExec(command, ctx, ['-T', 'box']);
    expect(calls.map((call) => call.tty)).toEqual(['force', 'always', 'no']);
    await expect(runExec(command, ctx, ['-t', '-T', 'box'])).rejects.toBeInstanceOf(UsageError);
  });

  test('-n, --stdin-file and @path select the stdin source; --stdin is a no-op', async () => {
    const { ctx } = await testContext(notFoundFetch);
    const { calls, command } = fakeRun();
    await runExec(command, ctx, ['-n', 'box', 'cat']);
    await runExec(command, ctx, ['--stdin-file', 'a.txt', 'box', 'cat']);
    await runExec(command, ctx, ['box', '@b.txt', 'cat']);
    await runExec(command, ctx, ['--stdin', 'box', 'cat']);
    expect(calls.map((call) => call.stdin)).toEqual([
      'none',
      { file: 'a.txt' },
      { file: 'b.txt' },
      'auto',
    ]);
    await expect(
      runExec(command, ctx, ['-n', '--stdin-file', 'a', 'box', 'cat'])
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      runExec(command, ctx, ['--stdin-file', 'a', 'box', '@b', 'cat'])
    ).rejects.toBeInstanceOf(UsageError);
  });

  test('--cwd, --env, -v and an explicit --timeout reach the run options', async () => {
    const { ctx } = await testContext(notFoundFetch, { timeoutMs: 90_000 });
    const { calls, command } = fakeRun();
    await runExec(command, ctx, [
      '--cwd',
      '/srv',
      '--env',
      'A=1',
      '--env',
      'B=2',
      '-v',
      'box',
      'env',
    ]);
    expect(calls[0]).toMatchObject({
      cwd: '/srv',
      env: { A: '1', B: '2' },
      verbose: true,
      timeoutMs: 90_000,
    });
    await expect(runExec(command, ctx, ['--env', 'oops', 'box', 'env'])).rejects.toBeInstanceOf(
      UsageError
    );
  });

  test('--script reads the shebang, streams the file as stdin and has no size cap', async () => {
    const dir = await tempDir('vt-exec-script-');
    const file = join(dir, 'run.sh');
    await writeFile(file, `#!/usr/bin/env bash\n${'x'.repeat(900 * 1024)}\n`);
    const { ctx } = await testContext(notFoundFetch);
    const { calls, command } = fakeRun();
    await runExec(command, ctx, ['--script', file, 'box']);
    expect(calls[0]?.command).toEqual({ kind: 'argv', argv: ['bash', '-s'] });
    expect(calls[0]?.stdin).toEqual({ file });
  });

  test('--script without a shell shebang falls back to /bin/sh -s and warns', async () => {
    const dir = await tempDir('vt-exec-py-');
    const file = join(dir, 'run.py');
    await writeFile(file, '#!/usr/bin/python3\nprint(1)\n');
    const { ctx, stderr } = await testContext(notFoundFetch);
    const { calls, command } = fakeRun();
    await runExec(command, ctx, ['--script', file, 'box']);
    expect(calls[0]?.command).toEqual({ kind: 'argv', argv: ['/bin/sh', '-s'] });
    expect(stderr.text()).toContain('python3');
    expect(stderr.text()).toContain('/bin/sh -s');
  });

  test('--interpreter overrides the shebang and requires --script', async () => {
    const dir = await tempDir('vt-exec-int-');
    const file = join(dir, 'run.sh');
    await writeFile(file, '#!/bin/bash\necho hi\n');
    const { ctx } = await testContext(notFoundFetch);
    const { calls, command } = fakeRun();
    await runExec(command, ctx, ['--script', file, '--interpreter', '/bin/zsh', 'box']);
    expect(calls[0]?.command).toEqual({ kind: 'argv', argv: ['/bin/zsh', '-s'] });
    await expect(
      runExec(command, ctx, ['--interpreter', '/bin/zsh', 'box', 'ls'])
    ).rejects.toBeInstanceOf(UsageError);
  });

  test('--script is exclusive with a command, --shell, stdin options and a missing file is a usage error', async () => {
    const dir = await tempDir('vt-exec-excl-');
    const file = join(dir, 'run.sh');
    await writeFile(file, 'echo x\n');
    const { ctx } = await testContext(notFoundFetch);
    const { calls, command } = fakeRun();
    for (const extra of [
      ['box', 'true'],
      ['--shell', 'box'],
      ['--stdin', 'box'],
      ['-n', 'box'],
      ['--stdin-file', 'x', 'box'],
    ]) {
      await expect(runExec(command, ctx, ['--script', file, ...extra])).rejects.toBeInstanceOf(
        UsageError
      );
    }
    const error = await runExec(command, ctx, ['--script', join(dir, 'nope.sh'), 'box']).catch(
      (err) => err
    );
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('cannot read --script');
    expect(calls).toHaveLength(0);
  });

  test('a window / pane location in the target is a usage error from the runner', async () => {
    const { ctx } = await testContext(notFoundFetch);
    const command = buildExecCommand({
      run: (innerCtx, options) =>
        runRemote(innerCtx, { ...options, terminal: fakeTerminal().term }),
    });
    await expect(runExec(command, ctx, ['box:1.0', 'ls'])).rejects.toBeInstanceOf(UsageError);
  });
});

describe('vibeterm exec exit codes', () => {
  const cases: Array<[string, Partial<ExecChannelResult>, number]> = [
    ['remote exit code', { exitCode: 7 }, 7],
    ['signal', { exitCode: null, signal: 'SIGTERM' }, 143],
    ['timeout', { exitCode: null, signal: 'SIGKILL', reason: 'timeout' }, 124],
    ['output closed', { exitCode: null, signal: 'SIGPIPE', reason: 'killed' }, 141],
  ];
  for (const [name, result, expected] of cases) {
    test(name, async () => {
      const { ctx } = await testContext(notFoundFetch);
      const { command } = fakeRun(undefined, result);
      expect(await runExec(command, ctx, ['box', 'x'])).toBe(expected);
    });
  }

  test('CLI-side failures keep their error classes', async () => {
    const { ctx } = await testContext(notFoundFetch);
    const auth = buildExecCommand({
      run: async () => {
        throw new AuthError('login required');
      },
    });
    const net = buildExecCommand({
      run: async () => {
        throw new NetworkError('down');
      },
    });
    const authError = await runExec(auth, ctx, ['box', 'x']).catch((err) => err);
    expect(authError.exitCode).toBe(3);
    const netError = await runExec(net, ctx, ['box', 'x']).catch((err) => err);
    expect(netError.exitCode).toBe(5);
    await expect(runExec(auth, ctx, [])).rejects.toBeInstanceOf(UsageError);
  });
});

describe('vibeterm exec output modes', () => {
  test('raw mode (the default) hands no sinks to the runner unless files are requested', async () => {
    const { ctx, stdout } = await testContext(notFoundFetch);
    const { calls, command } = fakeRun();
    await runExec(command, ctx, ['box', 'x']);
    expect(calls[0]?.sinks).toEqual({});
    expect(stdout.text()).toBe('');
  });

  test('raw mode with --stdout-file tees only that stream into the file (0600)', async () => {
    const dir = await tempDir('vt-exec-raw-file-');
    const out = join(dir, 'out.bin');
    const { ctx, stdout } = await testContext(notFoundFetch);
    const { calls, command } = fakeRun(async (options) => {
      await options.sinks?.stdout?.(Uint8Array.from([0, 255, 1]));
    });
    await runExec(command, ctx, ['--stdout-file', out, 'box', 'x']);
    expect(calls[0]?.sinks?.stderr).toBeUndefined();
    expect(Array.from(await readFile(out))).toEqual([0, 255, 1]);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect(stdout.text()).toBe('');
  });

  test('--tail, --max-bytes and --stream need --json', async () => {
    const { ctx } = await testContext(notFoundFetch);
    const { calls, command } = fakeRun();
    for (const extra of [['--tail', '4'], ['--max-bytes', '2048'], ['--stream']]) {
      await expect(runExec(command, ctx, [...extra, 'box', 'x'])).rejects.toBeInstanceOf(
        UsageError
      );
    }
    expect(calls).toHaveLength(0);
  });

  test('--json collects both streams into the documented payload', async () => {
    const { ctx, stdout } = await testContext(notFoundFetch, { json: true });
    const { command } = fakeRun(
      async (options) => {
        await options.sinks?.stdout?.(textBytes('hi\n'));
        await options.sinks?.stderr?.(textBytes('warn\n'));
      },
      { exitCode: 7 }
    );
    expect(await runExec(command, ctx, ['box', 'x'])).toBe(7);
    expect(JSON.parse(stdout.text())).toEqual({
      exitCode: 7,
      signal: null,
      stdout: 'hi\n',
      stderr: 'warn\n',
      durationMs: 12,
      truncated: { stdout: false, stderr: false },
      reason: 'exit',
    });
  });

  test('--json --tail keeps the last N bytes and marks truncation', async () => {
    const { ctx, stdout } = await testContext(notFoundFetch, { json: true });
    const { command } = fakeRun(async (options) => {
      await options.sinks?.stdout?.(textBytes('abcdefghij'));
    });
    await runExec(command, ctx, ['--tail', '4', 'box', 'x']);
    expect(JSON.parse(stdout.text())).toMatchObject({
      stdout: 'ghij',
      truncated: { stdout: true, stderr: false },
    });
  });

  test('--json caps the inline output at --max-bytes and still counts the rest', async () => {
    const { ctx, stdout } = await testContext(notFoundFetch, { json: true });
    const { command } = fakeRun(async (options) => {
      await options.sinks?.stdout?.(textBytes('a'.repeat(1500)));
      await options.sinks?.stdout?.(textBytes('b'.repeat(1500)));
    });
    await runExec(command, ctx, ['--max-bytes', '2048', 'box', 'x']);
    const payload = JSON.parse(stdout.text()) as { stdout: string; truncated: { stdout: boolean } };
    expect(payload.stdout).toHaveLength(2048);
    expect(payload.stdout.endsWith('b')).toBe(true);
    expect(payload.truncated.stdout).toBe(true);
  });

  test('--max-bytes defaults to 8 MiB only in json mode (no truncation below that)', async () => {
    const { ctx, stdout } = await testContext(notFoundFetch, { json: true });
    const { command } = fakeRun(async (options) => {
      await options.sinks?.stdout?.(Buffer.alloc(3 * 1024 * 1024, 0x61));
    });
    await runExec(command, ctx, ['box', 'x']);
    const payload = JSON.parse(stdout.text()) as { stdout: string; truncated: { stdout: boolean } };
    expect(payload.stdout).toHaveLength(3 * 1024 * 1024);
    expect(payload.truncated.stdout).toBe(false);
  });

  test('--json --stdout-file writes the file and replaces the inline string', async () => {
    const dir = await tempDir('vt-exec-out-');
    const out = join(dir, 'stdout.txt');
    const { ctx, stdout } = await testContext(notFoundFetch, { json: true });
    const { command } = fakeRun(async (options) => {
      await options.sinks?.stdout?.(textBytes('file-payload'));
    });
    await runExec(command, ctx, ['--stdout-file', out, 'box', 'x']);
    const payload = JSON.parse(stdout.text()) as Record<string, unknown>;
    expect(payload.stdout).toBeUndefined();
    expect(payload.stdoutPath).toBe(out);
    expect(payload.stdoutBytes).toBe(12);
    expect(payload.stderr).toBe('');
    expect(await readFile(out, 'utf8')).toBe('file-payload');
    expect((await stat(out)).mode & 0o777).toBe(0o600);
  });

  test('inline JSON over 64 KiB hints --tail / --stdout-file on stderr', async () => {
    const { ctx, stderr } = await testContext(notFoundFetch, { json: true });
    const { command } = fakeRun(async (options) => {
      await options.sinks?.stdout?.(Buffer.alloc(64 * 1024 + 1, 0x61));
    });
    await runExec(command, ctx, ['box', 'x']);
    expect(stderr.text()).toContain('--tail');
    expect(stderr.text()).toContain('--stdout-file');
  });

  test('--json --stream emits stdout/stderr events then exit', async () => {
    const { ctx, stdout } = await testContext(notFoundFetch, { json: true });
    const { command } = fakeRun(
      async (options) => {
        await options.sinks?.stdout?.(textBytes('hi'));
        await options.sinks?.stderr?.(textBytes('e'));
      },
      { exitCode: 2 }
    );
    await runExec(command, ctx, ['--stream', 'box', 'x']);
    const lines = stdout
      .text()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toEqual([
      { type: 'stdout', base64: Buffer.from('hi').toString('base64') },
      { type: 'stderr', base64: Buffer.from('e').toString('base64') },
      { type: 'exit', code: 2, signal: null, durationMs: 12, reason: 'exit' },
    ]);
  });

  test('a legacy stream death prints EXEC_STREAM_CLOSED JSON (with file paths) and rethrows', async () => {
    const dir = await tempDir('vt-exec-closed-');
    const out = join(dir, 'partial.txt');
    const { ctx, stdout } = await testContext(notFoundFetch, { json: true });
    const command = buildExecCommand({
      run: async () => {
        throw new ExecStreamClosedError('terminated', 50, 7, 0);
      },
    });
    const error = await runExec(command, ctx, ['--stdout-file', out, 'box', 'x']).catch(
      (err) => err
    );
    expect(error).toBeInstanceOf(ExecStreamClosedError);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: false,
      code: EXEC_STREAM_CLOSED,
      reason: 'terminated',
      stdoutPath: out,
      stdoutBytes: 7,
    });
  });

  test('a missing --stdout-file directory fails before the runner is called', async () => {
    const { ctx } = await testContext(notFoundFetch);
    const { calls, command } = fakeRun();
    const error = await runExec(command, ctx, [
      '--stdout-file',
      '/nonexistent-dir-xyz-vt/out.txt',
      'box',
      'x',
    ]).catch((err) => err);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('cannot open --stdout-file');
    expect(calls).toHaveLength(0);
  });

  test('--tail 0 is a usage error and leaves an existing --stdout-file alone', async () => {
    const dir = await tempDir('vt-exec-tail0-');
    const out = join(dir, 'existing.log');
    await writeFile(out, 'keep-me');
    const { ctx } = await testContext(notFoundFetch, { json: true });
    const { calls, command } = fakeRun();
    const error = await runExec(command, ctx, [
      '--tail',
      '0',
      '--stdout-file',
      out,
      'box',
      'x',
    ]).catch((err) => err);
    expect(error).toBeInstanceOf(UsageError);
    expect(calls).toHaveLength(0);
    expect(await readFile(out, 'utf8')).toBe('keep-me');
  });
});

describe('vibeterm exec end to end over the fake channel', () => {
  function realDeps(
    link: ReturnType<typeof fakeLink>,
    term: ReturnType<typeof fakeTerminal>
  ): ExecDeps {
    return {
      run: (ctx, options) =>
        runRemote(ctx, {
          ...options,
          terminal: term.term,
          channel: { connect: link.connect, timing: FAST },
        }),
    };
  }

  function helloOf(conn: ServerConn) {
    const hello = conn.hello();
    if (hello?.op !== 'open') throw new Error('expected an open HELLO');
    return hello.spec;
  }

  test('output is raw by default, even when stdout is not a terminal, and carries the exit code', async () => {
    const { ctx, stdout } = await testContext(notFoundFetch);
    const term = fakeTerminal();
    const bytes = Uint8Array.from([0, 255, 10, 13, 128]);
    const link = fakeLink((conn) =>
      onHello(conn, () => {
        conn.sendJson(EcKind.READY, readyOf());
        conn.send(EcKind.STDOUT, bytes);
        conn.send(EcKind.STDERR, textBytes('warn\n'));
        conn.sendJson(EcKind.EXIT, { code: 5, signal: null, reason: 'exit', durationMs: 3 });
      })
    );
    const code = await runExec(buildExecCommand(realDeps(link, term)), ctx, ['box', 'cat', 'blob']);
    expect(code).toBe(5);
    expect(Array.from(term.stdout())).toEqual(Array.from(bytes));
    expect(term.stderr().toString()).toBe('warn\n');
    expect(stdout.text()).toBe('');
    expect(helloOf(link.conns[0] as ServerConn)).toMatchObject({
      device: 'box',
      command: { kind: 'shell', script: 'cat blob' },
      pty: null,
    });
  });

  test('a piped stdin (heredoc) is forwarded and ends the command', async () => {
    const { ctx } = await testContext(notFoundFetch);
    const term = fakeTerminal({
      stdin: Readable.from([Buffer.from('set -e\n'), Buffer.from('hostname\n')]),
    });
    const link = fakeLink((conn) => {
      conn.onFrame = (frame) => {
        if (frame.kind === EcKind.HELLO) conn.sendJson(EcKind.READY, readyOf());
        if (frame.kind === EcKind.STDIN_EOF) conn.sendJson(EcKind.EXIT, EXIT_OK);
      };
    });
    await runExec(buildExecCommand(realDeps(link, term)), ctx, ['box', 'bash -s']);
    const conn = link.conns[0] as ServerConn;
    expect(Buffer.from(conn.bytes(EcKind.STDIN)).toString()).toBe('set -e\nhostname\n');
    expect(helloOf(conn).stdin).toBe(true);
  });

  test('-n sends no stdin even for a piped stdin', async () => {
    const { ctx } = await testContext(notFoundFetch);
    const term = fakeTerminal({ stdin: Readable.from([Buffer.from('ignored')]) });
    const link = fakeLink((conn) =>
      onHello(conn, () => {
        conn.sendJson(EcKind.READY, readyOf());
        conn.sendJson(EcKind.EXIT, EXIT_OK);
      })
    );
    await runExec(buildExecCommand(realDeps(link, term)), ctx, ['-n', 'box', 'true']);
    const conn = link.conns[0] as ServerConn;
    expect(helloOf(conn).stdin).toBe(false);
    expect(conn.has(EcKind.STDIN)).toBe(false);
  });

  test('--json collects the channel output into the payload', async () => {
    const { ctx, stdout } = await testContext(notFoundFetch, { json: true });
    const term = fakeTerminal();
    const link = fakeLink((conn) =>
      onHello(conn, () => {
        conn.sendJson(EcKind.READY, readyOf());
        conn.send(EcKind.STDOUT, textBytes('hi\n'));
        conn.sendJson(EcKind.EXIT, { code: 7, signal: null, reason: 'exit', durationMs: 9 });
      })
    );
    expect(await runExec(buildExecCommand(realDeps(link, term)), ctx, ['box', 'x'])).toBe(7);
    expect(JSON.parse(stdout.text())).toMatchObject({
      exitCode: 7,
      stdout: 'hi\n',
      reason: 'exit',
      durationMs: 9,
    });
    expect(term.stdout().byteLength).toBe(0);
  });

  test('an old node falls back to POST /api/exec with raw output and one warning', async () => {
    const posts: Array<Record<string, unknown>> = [];
    const { ctx, stderr } = await testContext(async (input, init) => {
      const path = new URL(input).pathname;
      if (path === '/api/devices') return jsonResponse({ devices: [LEGACY_DEVICE] });
      if (path === '/api/mesh/nodes') return jsonResponse({ nodes: [] });
      if (path === '/api/auth/mode') return jsonResponse({ nodeId: 'self', mode: 'none' });
      if (path === '/api/exec' && init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return ndjsonResponse([
          { type: 'stdout', base64: Buffer.from('legacy\n').toString('base64') },
          { ...LEGACY_EXIT, code: 3 },
        ]);
      }
      return jsonResponse({ error: 'Not found' }, 404);
    });
    const term = fakeTerminal({ stdinTty: true } satisfies FakeTerminalOptions);
    const link = fakeLink((conn) => conn.drop(4404, ''));
    const code = await runExec(buildExecCommand(realDeps(link, term)), ctx, ['laptop', 'uname']);
    expect(code).toBe(3);
    expect(term.stdout().toString()).toBe('legacy\n');
    expect(posts[0]).toMatchObject({ deviceId: 'dev-1', argv: ['uname'], shell: true });
    expect(stderr.text()).not.toContain('using device');
    expect(stderr.text().match(/兼容模式/g)).toHaveLength(1);
  });
});
