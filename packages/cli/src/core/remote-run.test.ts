// runRemote：进程内假 EC1 服务端（exec-channel-fakes.ts）+ 假终端（remote-run-fakes.ts），不走网络。

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EcKind, type ExecCommand, type ExecOpenSpec } from '@vibeterm/shared/exec-channel';
import { ENTRY, NODE, jsonResponse, meshNode, testContext } from '../commands/cli-test-harness';
import { NetworkError, NotFoundError, UsageError } from './errors';
import { ExecChannelUnsupportedError, exitCodeOf } from './exec-channel';
import {
  EXIT_OK,
  FAST,
  type ServerConn,
  fakeLink,
  onHello,
  readyOf,
  textBytes,
  waitFor,
} from './exec-channel-fakes';
import { type RemoteRunOptions, runRemote } from './remote-run';
import {
  type FakeTerminalOptions,
  LEGACY_DEVICE,
  LEGACY_EXIT,
  fakeTerminal,
  ndjsonResponse,
} from './remote-run-fakes';
import { decidePty, fdWriter } from './remote-run-io';
import { TargetCache, bareKey, nodeKey } from './target-cache';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const SHELL: ExecCommand = { kind: 'shell', script: 'echo hi' };

type Fixture = {
  mesh: { calls: number };
  posts: Array<Record<string, unknown>>;
};

function restFetch(fixture: Fixture, exec?: () => Response) {
  return async (input: string, init?: { method?: string; body?: unknown }): Promise<Response> => {
    const path = new URL(input).pathname;
    if (path === '/api/mesh/nodes') {
      fixture.mesh.calls += 1;
      return jsonResponse({ nodes: [meshNode()] });
    }
    if (path === '/api/auth/mode') return jsonResponse({ nodeId: 'self', mode: 'none' });
    if (path === '/api/devices') return jsonResponse({ devices: [LEGACY_DEVICE] });
    if (path === '/api/exec' && init?.method === 'POST') {
      fixture.posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return exec?.() ?? ndjsonResponse([LEGACY_EXIT]);
    }
    return jsonResponse({ error: 'Not found' }, 404);
  };
}

async function setup(options: { terminal?: FakeTerminalOptions; exec?: () => Response } = {}) {
  const fixture: Fixture = { mesh: { calls: 0 }, posts: [] };
  const harness = await testContext(restFetch(fixture, options.exec));
  dirs.push(harness.dir);
  const terminal = fakeTerminal(options.terminal);
  return { ...harness, fixture, terminal };
}

function serveExit(output: Uint8Array[] = [], exit: object = EXIT_OK) {
  return (conn: ServerConn) =>
    onHello(conn, () => {
      conn.sendJson(EcKind.READY, readyOf());
      for (const bytes of output) conn.send(EcKind.STDOUT, bytes);
      conn.sendJson(EcKind.EXIT, exit);
    });
}

function serveStdin(conn: ServerConn): void {
  conn.onFrame = (frame) => {
    if (frame.kind === EcKind.HELLO) conn.sendJson(EcKind.READY, readyOf());
    if (frame.kind === EcKind.STDIN_EOF) conn.sendJson(EcKind.EXIT, EXIT_OK);
  };
}

function optionsOf(
  terminal: ReturnType<typeof fakeTerminal>,
  link: ReturnType<typeof fakeLink>,
  extra: Partial<RemoteRunOptions> = {}
): RemoteRunOptions {
  return {
    target: 'box',
    command: SHELL,
    tty: 'auto',
    stdin: 'auto',
    legacyFallback: false,
    terminal: terminal.term,
    channel: { connect: link.connect, timing: FAST },
    ...extra,
  };
}

function specOf(conn: ServerConn): ExecOpenSpec {
  const hello = conn.hello();
  if (hello?.op !== 'open') throw new Error('expected an open HELLO');
  return hello.spec;
}

describe('decidePty', () => {
  const cases: Array<[Parameters<typeof decidePty>[0], ExecCommand['kind'], boolean, boolean]> = [
    ['auto', 'login', true, true],
    ['auto', 'login', false, false],
    ['auto', 'shell', true, false],
    ['force', 'shell', true, true],
    ['force', 'shell', false, false],
    ['always', 'shell', false, true],
    ['no', 'login', true, false],
  ];
  for (const [mode, kind, inTty, expected] of cases) {
    test(`${mode} ${kind} stdinTty=${inTty} → ${expected}`, () => {
      const command = (
        kind === 'login' ? { kind: 'login' } : { kind: 'shell', script: 'x' }
      ) as ExecCommand;
      expect(decidePty(mode, command, inTty)).toBe(expected);
    });
  }
});

describe('runRemote output and spec', () => {
  test('relays raw binary stdout/stderr to the terminal fds and returns the exit status', async () => {
    const { ctx, terminal } = await setup();
    const bin = Uint8Array.from([0, 255, 10, 13, 128]);
    const link = fakeLink((conn) =>
      onHello(conn, () => {
        conn.sendJson(EcKind.READY, readyOf());
        conn.send(EcKind.STDOUT, bin);
        conn.send(EcKind.STDERR, textBytes('warn\n'));
        conn.sendJson(EcKind.EXIT, { code: 3, signal: null, reason: 'exit', durationMs: 5 });
      })
    );
    const result = await runRemote(ctx, optionsOf(terminal, link));
    expect(Array.from(terminal.stdout())).toEqual(Array.from(bin));
    expect(terminal.stderr().toString('utf8')).toBe('warn\n');
    expect(exitCodeOf(result)).toBe(3);
    const spec = specOf(link.conns[0] as ServerConn);
    expect(spec).toMatchObject({ device: 'box', command: SHELL, pty: null });
    expect(spec).not.toHaveProperty('timeoutMs');
    expect(spec).not.toHaveProperty('cwd');
  });

  test('never prints the device notice unless verbose', async () => {
    const quiet = await setup();
    await runRemote(quiet.ctx, optionsOf(quiet.terminal, fakeLink(serveExit())));
    expect(quiet.stderr.text()).toBe('');

    const loud = await setup();
    await runRemote(loud.ctx, optionsOf(loud.terminal, fakeLink(serveExit()), { verbose: true }));
    expect(loud.stderr.text()).toContain('using device box on node self');
  });

  test('cwd, env and a positive timeout reach the spec; zero timeout is unlimited', async () => {
    const { ctx, terminal } = await setup();
    const link = fakeLink(serveExit());
    await runRemote(
      ctx,
      optionsOf(terminal, link, { cwd: '/srv', env: { A: '1' }, timeoutMs: 5000 })
    );
    expect(specOf(link.conns[0] as ServerConn)).toMatchObject({
      cwd: '/srv',
      env: { A: '1' },
      timeoutMs: 5000,
    });
    const zero = fakeLink(serveExit());
    await runRemote(ctx, optionsOf(terminal, zero, { timeoutMs: 0 }));
    expect(specOf(zero.conns[0] as ServerConn)).not.toHaveProperty('timeoutMs');
  });

  test('timeout and signal exits map to 124 and 128+n', async () => {
    const { ctx, terminal } = await setup();
    const timeout = await runRemote(
      ctx,
      optionsOf(
        terminal,
        fakeLink(serveExit([], { code: null, signal: 'SIGKILL', reason: 'timeout', durationMs: 1 }))
      )
    );
    expect(exitCodeOf(timeout)).toBe(124);
    const killed = await runRemote(
      ctx,
      optionsOf(
        terminal,
        fakeLink(serveExit([], { code: null, signal: 'SIGTERM', reason: 'exit', durationMs: 1 }))
      )
    );
    expect(exitCodeOf(killed)).toBe(143);
  });

  test('custom sinks replace the default fd writers', async () => {
    const { ctx, terminal } = await setup();
    const seen: string[] = [];
    const link = fakeLink(serveExit([textBytes('data')]));
    await runRemote(
      ctx,
      optionsOf(terminal, link, {
        sinks: {
          stdout: async (bytes) => {
            seen.push(Buffer.from(bytes).toString());
          },
        },
      })
    );
    expect(seen).toEqual(['data']);
    expect(terminal.stdout().byteLength).toBe(0);
  });

  test('a LocalOutputClosedError from the sink is a quiet SIGPIPE stop', async () => {
    const { ctx, terminal, stderr } = await setup();
    const link = fakeLink(serveExit([textBytes('a')]));
    const result = await runRemote(
      ctx,
      optionsOf(terminal, link, {
        sinks: {
          stdout: async () => {
            throw Object.assign(new Error('closed'), { name: 'LocalOutputClosedError' });
          },
        },
      })
    );
    expect(exitCodeOf(result)).toBe(141);
    expect(stderr.text()).toBe('');
  });

  test('EPIPE on stdout stops cleanly like ssh into head: SIGPIPE, kill sent', async () => {
    const { ctx, terminal } = await setup({
      terminal: {
        writeStdout: (_chunk, callback) =>
          callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })),
      },
    });
    const link = fakeLink((conn) =>
      onHello(conn, () => {
        conn.sendJson(EcKind.READY, readyOf());
        conn.send(EcKind.STDOUT, textBytes('a'));
        setTimeout(() => conn.send(EcKind.STDOUT, textBytes('b')), 30);
      })
    );
    const result = await runRemote(ctx, optionsOf(terminal, link));
    expect(result.signal).toBe('SIGPIPE');
    expect(exitCodeOf(result)).toBe(141);
    const conn = link.conns[0] as ServerConn;
    await waitFor(() => conn.has(EcKind.CLOSE));
    expect(conn.json<{ kill: boolean }>(EcKind.CLOSE)).toEqual([{ kill: true }]);
  });
});

describe('fdWriter', () => {
  test('waits for drain when the stream applies backpressure', async () => {
    const { Writable } = await import('node:stream');
    const written: number[] = [];
    const stream = new Writable({
      highWaterMark: 4,
      write(chunk, _encoding, callback) {
        written.push(chunk.byteLength);
        setTimeout(callback, 25);
      },
    });
    const write = fdWriter(stream);
    const started = Date.now();
    await write(new Uint8Array(10));
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    expect(written).toEqual([10]);
  });

  test('a destroyed stream rejects with the clean-stop error', async () => {
    const { Writable } = await import('node:stream');
    const stream = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    const write = fdWriter(stream);
    stream.destroy();
    const error = await write(new Uint8Array(1)).catch((err) => err);
    expect((error as Error).name).toBe('OutputClosedError');
  });
});

describe('runRemote stdin', () => {
  test('forwards a piped stdin without a size cap and sends EOF', async () => {
    const payload = Buffer.alloc(3 * 1024 * 1024, 7);
    const { ctx, terminal } = await setup({
      terminal: { stdin: Readable.from([payload.subarray(0, 1024), payload.subarray(1024)]) },
    });
    const link = fakeLink(serveStdin);
    await runRemote(ctx, optionsOf(terminal, link));
    const conn = link.conns[0] as ServerConn;
    expect(specOf(conn).stdin).toBe(true);
    expect(conn.bytes(EcKind.STDIN).byteLength).toBe(payload.byteLength);
    expect(conn.has(EcKind.STDIN_EOF)).toBe(true);
  });

  test('a terminal stdin is forwarded in line mode without a pty (ssh semantics)', async () => {
    const { ctx, terminal } = await setup({
      terminal: { stdin: Readable.from([Buffer.from('line\n')]), stdinTty: true },
    });
    const link = fakeLink(serveStdin);
    await runRemote(ctx, optionsOf(terminal, link));
    const conn = link.conns[0] as ServerConn;
    expect(specOf(conn)).toMatchObject({ stdin: true, pty: null });
    expect(Buffer.from(conn.bytes(EcKind.STDIN)).toString()).toBe('line\n');
    expect(conn.has(EcKind.STDIN_EOF)).toBe(true);
    expect(terminal.rawModes).toEqual([]);
  });

  test('-n does not forward a terminal stdin either', async () => {
    const { ctx, terminal } = await setup({ terminal: { stdinTty: true } });
    const link = fakeLink(serveExit());
    await runRemote(ctx, optionsOf(terminal, link, { stdin: 'none' }));
    expect(specOf(link.conns[0] as ServerConn).stdin).toBe(false);
  });

  test('none (-n) never forwards even when stdin is a pipe', async () => {
    const { ctx, terminal } = await setup({
      terminal: { stdin: Readable.from([Buffer.from('ignored')]) },
    });
    const link = fakeLink(serveExit());
    await runRemote(ctx, optionsOf(terminal, link, { stdin: 'none' }));
    const conn = link.conns[0] as ServerConn;
    expect(specOf(conn).stdin).toBe(false);
    expect(conn.has(EcKind.STDIN)).toBe(false);
  });

  test('{file} streams the file contents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-rr-stdin-'));
    dirs.push(dir);
    const file = join(dir, 'in.txt');
    await writeFile(file, 'from-file');
    const { ctx, terminal } = await setup({ terminal: { stdinTty: true } });
    const link = fakeLink(serveStdin);
    await runRemote(ctx, optionsOf(terminal, link, { stdin: { file } }));
    expect(Buffer.from((link.conns[0] as ServerConn).bytes(EcKind.STDIN)).toString()).toBe(
      'from-file'
    );
  });

  test('an unreadable stdin file is a usage error before any connection', async () => {
    const { ctx, terminal } = await setup();
    const link = fakeLink(serveExit());
    const error = await runRemote(
      ctx,
      optionsOf(terminal, link, { stdin: { file: '/nonexistent-vt/in.txt' } })
    ).catch((err) => err);
    expect(error).toBeInstanceOf(UsageError);
    expect(link.conns).toHaveLength(0);
  });
});

describe('runRemote pty', () => {
  test('-tt allocates a pty even when stdin is a pipe, sized from the stdout terminal', async () => {
    const { ctx, terminal } = await setup({
      terminal: { stdin: Readable.from([Buffer.from('x')]), term: 'xterm-test' },
    });
    const link = fakeLink(serveStdin);
    await runRemote(ctx, optionsOf(terminal, link, { tty: 'always' }));
    const conn = link.conns[0] as ServerConn;
    expect(specOf(conn)).toMatchObject({
      pty: { cols: 100, rows: 30, term: 'xterm-test' },
      stdin: true,
    });
    expect(Buffer.from(conn.bytes(EcKind.STDIN)).toString()).toBe('x');
  });

  test('a login command on a terminal gets a pty and raw mode is restored', async () => {
    const { ctx, terminal } = await setup({ terminal: { stdinTty: true, stdoutTty: true } });
    const link = fakeLink((conn) =>
      onHello(conn, () => {
        conn.sendJson(EcKind.READY, readyOf({ pty: true }));
        conn.sendJson(EcKind.EXIT, EXIT_OK);
      })
    );
    await runRemote(ctx, optionsOf(terminal, link, { command: { kind: 'login' } }));
    expect(specOf(link.conns[0] as ServerConn).pty).toMatchObject({ cols: 100, rows: 30 });
    expect(terminal.rawModes).toEqual([true, false]);
  });

  test('-t without a terminal stdin warns once and runs without a pty', async () => {
    const { ctx, terminal, stderr } = await setup();
    const link = fakeLink(serveExit());
    await runRemote(ctx, optionsOf(terminal, link, { tty: 'force' }));
    expect(specOf(link.conns[0] as ServerConn).pty).toBeNull();
    expect(stderr.text().match(/未分配伪终端/g)).toHaveLength(1);
  });

  test('a login command gets a pty from stdin alone, even when stdout is redirected', async () => {
    const { ctx, terminal } = await setup({ terminal: { stdinTty: true, stdoutTty: false } });
    const link = fakeLink(serveExit());
    await runRemote(ctx, optionsOf(terminal, link, { command: { kind: 'login' } }));
    expect(specOf(link.conns[0] as ServerConn).pty).toMatchObject({ cols: 100, rows: 30 });
  });

  test('a plain command never gets a pty in auto mode, and -T disables it', async () => {
    const { ctx, terminal, stderr } = await setup({
      terminal: { stdinTty: true, stdoutTty: true },
    });
    const auto = fakeLink(serveExit());
    await runRemote(ctx, optionsOf(terminal, auto));
    expect(specOf(auto.conns[0] as ServerConn).pty).toBeNull();
    const no = fakeLink(serveExit());
    await runRemote(ctx, optionsOf(terminal, no, { command: { kind: 'login' }, tty: 'no' }));
    expect(specOf(no.conns[0] as ServerConn).pty).toBeNull();
    expect(stderr.text()).toBe('');
  });
});

describe('runRemote target resolution', () => {
  function deviceMissing(conn: ServerConn): void {
    onHello(conn, () =>
      conn.sendJson(EcKind.ERROR, { code: 'device_not_found', message: 'no such device' })
    );
  }

  /** 假 node：`names` 把 node id 映射到它**当前**的名字；open 带的 nodeName 对不上就 device_not_found。 */
  function namedNodes(names: Record<string, string>) {
    return (conn: ServerConn): void => {
      const id = /\/n\/([0-9a-f]{32})/.exec(conn.target.url)?.[1];
      if (!id) {
        deviceMissing(conn);
        return;
      }
      onHello(conn, (hello) => {
        const expected = hello.op === 'open' ? hello.spec.nodeName : undefined;
        if (expected && expected.toLowerCase() !== names[id]?.toLowerCase()) {
          conn.sendJson(EcKind.ERROR, { code: 'device_not_found', message: 'node mismatch' });
          return;
        }
        conn.sendJson(EcKind.READY, readyOf());
        conn.sendJson(EcKind.EXIT, EXIT_OK);
      });
    };
  }

  test('a bare token is tried as a device on the entry first', async () => {
    const { ctx, terminal, fixture } = await setup();
    const link = fakeLink(serveExit());
    await runRemote(ctx, optionsOf(terminal, link));
    const conn = link.conns[0] as ServerConn;
    expect(conn.target.url).not.toContain('/n/');
    expect(specOf(conn).device).toBe('box');
    expect(fixture.mesh.calls).toBe(0);
  });

  test('device_not_found falls back to the node of that name and caches it', async () => {
    const { ctx, terminal, dir } = await setup();
    const link = fakeLink((conn) => (conn.index === 0 ? deviceMissing(conn) : serveExit()(conn)));
    await runRemote(ctx, optionsOf(terminal, link, { target: 'office' }));
    expect(link.conns).toHaveLength(2);
    expect(specOf(link.conns[0] as ServerConn).device).toBe('office');
    const second = link.conns[1] as ServerConn;
    expect(second.target.url).toContain(NODE);
    expect(specOf(second)).not.toHaveProperty('device');
    expect(TargetCache.open(dir, ENTRY).get(bareKey('office'))?.nodeId).toBe(NODE);
  });

  test('a cached bare token reaches its node after the entry device probe misses', async () => {
    const { ctx, terminal, dir, fixture } = await setup();
    TargetCache.open(dir, ENTRY).set(bareKey('office'), { nodeId: NODE, name: 'office' });
    const link = fakeLink(namedNodes({ [NODE]: 'office' }));
    await runRemote(ctx, optionsOf(terminal, link, { target: 'office' }));
    expect(link.conns).toHaveLength(2);
    expect((link.conns[0] as ServerConn).target.url).not.toContain('/n/');
    const second = link.conns[1] as ServerConn;
    expect(second.target.url).toContain(NODE);
    expect(specOf(second).nodeName).toBe('office');
    expect(fixture.mesh.calls).toBe(0);
  });

  test('a device on the entry beats a same-named cached node and drops it', async () => {
    const { ctx, terminal, dir, fixture } = await setup();
    TargetCache.open(dir, ENTRY).set(bareKey('db'), { nodeId: NODE, name: 'db' });
    const link = fakeLink(serveExit());
    await runRemote(ctx, optionsOf(terminal, link, { target: 'db' }));
    expect(link.conns).toHaveLength(1);
    const conn = link.conns[0] as ServerConn;
    expect(conn.target.url).not.toContain('/n/');
    expect(specOf(conn).device).toBe('db');
    expect(specOf(conn)).not.toHaveProperty('nodeName');
    expect(TargetCache.open(dir, ENTRY).get(bareKey('db'))).toBeNull();
    expect(fixture.mesh.calls).toBe(0);
  });

  test('a renamed node rejects a stale bare cache, which is re-resolved once', async () => {
    const { ctx, terminal, dir, fixture } = await setup();
    const old = 'c'.repeat(32);
    TargetCache.open(dir, ENTRY).set(bareKey('office'), { nodeId: old, name: 'office' });
    const link = fakeLink(namedNodes({ [old]: 'office-retired', [NODE]: 'office' }));
    await runRemote(ctx, optionsOf(terminal, link, { target: 'office' }));
    expect(link.conns).toHaveLength(3);
    expect((link.conns[0] as ServerConn).target.url).not.toContain('/n/');
    const stale = link.conns[1] as ServerConn;
    expect(stale.target.url).toContain(old);
    expect(specOf(stale).nodeName).toBe('office');
    const fresh = link.conns[2] as ServerConn;
    expect(fresh.target.url).toContain(NODE);
    expect(specOf(fresh)).not.toHaveProperty('nodeName');
    expect(fixture.mesh.calls).toBe(1);
    expect(TargetCache.open(dir, ENTRY).get(bareKey('office'))?.nodeId).toBe(NODE);
  });

  test('a token that is neither device nor node is a NotFoundError', async () => {
    const { ctx, terminal } = await setup();
    const link = fakeLink(deviceMissing);
    const error = await runRemote(ctx, optionsOf(terminal, link, { target: 'ghost' })).catch(
      (err) => err
    );
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as Error).message).toContain('unknown device or node: ghost');
  });

  test('node/device resolves the node once, then reuses the cache', async () => {
    const { ctx, terminal, fixture } = await setup();
    const link = fakeLink(serveExit());
    await runRemote(ctx, optionsOf(terminal, link, { target: 'office/db' }));
    await runRemote(ctx, optionsOf(terminal, link, { target: 'office/db' }));
    expect(link.conns).toHaveLength(2);
    for (const conn of link.conns) {
      expect(conn.target.url).toContain(NODE);
      expect(specOf(conn).device).toBe('db');
    }
    expect(fixture.mesh.calls).toBe(1);
  });

  test('a renamed node rejects a stale node/device cache, re-resolved once', async () => {
    const { ctx, terminal, dir, fixture } = await setup();
    const old = 'c'.repeat(32);
    TargetCache.open(dir, ENTRY).set(nodeKey('office'), { nodeId: old, name: 'office' });
    const link = fakeLink(namedNodes({ [old]: 'office-retired', [NODE]: 'office' }));
    await runRemote(ctx, optionsOf(terminal, link, { target: 'office/db' }));
    expect(link.conns).toHaveLength(2);
    const stale = link.conns[0] as ServerConn;
    expect(stale.target.url).toContain(old);
    expect(specOf(stale)).toMatchObject({ nodeName: 'office', device: 'db' });
    const fresh = link.conns[1] as ServerConn;
    expect(fresh.target.url).toContain(NODE);
    expect(specOf(fresh)).not.toHaveProperty('nodeName');
    expect(fixture.mesh.calls).toBe(1);
    expect(TargetCache.open(dir, ENTRY).get(nodeKey('office'))?.nodeId).toBe(NODE);
  });

  test('a node written as an id never carries an expected name', async () => {
    const { ctx, terminal, dir } = await setup();
    TargetCache.open(dir, ENTRY).set(nodeKey(NODE), { nodeId: NODE, name: 'office' });
    const link = fakeLink(serveExit());
    await runRemote(ctx, optionsOf(terminal, link, { target: `${NODE}/db` }));
    expect(specOf(link.conns[0] as ServerConn)).not.toHaveProperty('nodeName');
  });

  test('a fresh (uncached) NotFound on an explicit target is not retried', async () => {
    const { ctx, terminal } = await setup();
    const link = fakeLink(deviceMissing);
    const error = await runRemote(ctx, optionsOf(terminal, link, { target: 'office/db' })).catch(
      (err) => err
    );
    expect(error).toBeInstanceOf(NotFoundError);
    expect(link.conns).toHaveLength(1);
  });

  test('the node override makes the target a device on that node', async () => {
    const { ctx, terminal } = await setup();
    const link = fakeLink(serveExit());
    await runRemote(ctx, optionsOf(terminal, link, { target: 'db', node: 'office' }));
    const conn = link.conns[0] as ServerConn;
    expect(conn.target.url).toContain(NODE);
    expect(specOf(conn).device).toBe('db');
  });

  test('errors after the session started are never retried against another target', async () => {
    const { ctx, terminal } = await setup();
    const link = fakeLink((conn) =>
      onHello(conn, () => {
        conn.sendJson(EcKind.READY, readyOf());
        conn.sendJson(EcKind.ERROR, { code: 'device_not_found', message: 'vanished' });
      })
    );
    const error = await runRemote(ctx, optionsOf(terminal, link, { target: 'office' })).catch(
      (err) => err
    );
    expect(error).toBeInstanceOf(NotFoundError);
    expect(link.conns).toHaveLength(1);
  });

  test('without legacyFallback an unsupported node is a plain error', async () => {
    const { ctx, terminal } = await setup();
    const link = fakeLink((conn) => conn.drop(4404, ''));
    const error = await runRemote(ctx, optionsOf(terminal, link)).catch((err) => err);
    expect(error).toBeInstanceOf(ExecChannelUnsupportedError);
  });
});

describe('runRemote legacy fallback', () => {
  const unsupported = () => fakeLink((conn) => conn.drop(4404, ''));

  function legacyOptions(
    harness: Awaited<ReturnType<typeof setup>>,
    extra: Partial<RemoteRunOptions> = {}
  ): RemoteRunOptions {
    return optionsOf(harness.terminal, unsupported(), {
      target: 'laptop',
      legacyFallback: true,
      ...extra,
    });
  }

  test('maps a shell command and buffered stdin onto POST /api/exec with raw output', async () => {
    const harness = await setup({
      terminal: { stdin: Readable.from([Buffer.from('in')]) },
      exec: () =>
        ndjsonResponse([
          { type: 'stdout', base64: Buffer.from('hi\n').toString('base64') },
          { type: 'stderr', base64: Buffer.from('oops\n').toString('base64') },
          { ...LEGACY_EXIT, code: 4 },
        ]),
    });
    const result = await runRemote(
      harness.ctx,
      legacyOptions(harness, { cwd: '/srv', timeoutMs: 9_000_000 })
    );
    expect(harness.fixture.posts).toHaveLength(1);
    expect(harness.fixture.posts[0]).toMatchObject({
      deviceId: 'dev-1',
      argv: ['echo hi'],
      shell: true,
      cwd: '/srv',
      timeoutMs: 3_600_000,
      maxBytes: 8 * 1024 * 1024,
      stdin: { text: 'in' },
    });
    expect(harness.terminal.stdout().toString()).toBe('hi\n');
    expect(harness.terminal.stderr().toString()).toBe('oops\n');
    expect(exitCodeOf(result)).toBe(4);
    expect(result.device.name).toBe('laptop');
    const warning = harness.stderr.text();
    expect(warning).toContain('目标节点版本过旧，已使用兼容模式（输出上限 8 MiB）');
    expect(warning.match(/兼容模式/g)).toHaveLength(1);
    expect(warning).not.toContain('using device');
  });

  test('an argv command stays argv and binary stdin goes as base64', async () => {
    const harness = await setup({
      terminal: { stdin: Readable.from([Buffer.from([0xff, 0xfe, 0x00])]) },
    });
    await runRemote(
      harness.ctx,
      legacyOptions(harness, { command: { kind: 'argv', argv: ['cat', '-n'] } })
    );
    const body = harness.fixture.posts[0] as Record<string, unknown>;
    expect(body.argv).toEqual(['cat', '-n']);
    expect(body).not.toHaveProperty('shell');
    expect(body.stdin).toEqual({ base64: Buffer.from([0xff, 0xfe, 0x00]).toString('base64') });
  });

  test('a slow stdin pipe gets one hint after the idle window and is still read to EOF', async () => {
    const stdin = new Readable({ read() {} });
    const harness = await setup({ terminal: { stdin } });
    setTimeout(() => {
      stdin.push(Buffer.from('late data'));
      stdin.push(null);
    }, 120);
    const result = await runRemote(harness.ctx, legacyOptions(harness, { legacyStdinIdleMs: 30 }));
    expect(exitCodeOf(result)).toBe(0);
    expect(harness.fixture.posts[0]).toMatchObject({ stdin: { text: 'late data' } });
    expect(harness.stderr.text().match(/加 -n/g)).toHaveLength(1);
  });

  test('a terminal stdin is not read by the compat path (it cannot stream)', async () => {
    const harness = await setup({
      terminal: { stdin: new Readable({ read() {} }), stdinTty: true },
    });
    await runRemote(harness.ctx, legacyOptions(harness));
    expect(harness.fixture.posts[0]).not.toHaveProperty('stdin');
    expect(harness.stderr.text()).not.toContain('加 -n');
  });

  test('a slow stdin that delivers data and closes within the window is still buffered', async () => {
    const stdin = new Readable({ read() {} });
    const harness = await setup({ terminal: { stdin } });
    setTimeout(() => {
      stdin.push(Buffer.from('late'));
      stdin.push(null);
    }, 10);
    await runRemote(harness.ctx, legacyOptions(harness, { legacyStdinIdleMs: 500 }));
    expect(harness.fixture.posts[0]).toMatchObject({ stdin: { text: 'late' } });
    expect(harness.stderr.text()).not.toContain('加 -n');
  });

  test('timeout events map to the timeout exit', async () => {
    const harness = await setup({
      exec: () =>
        ndjsonResponse([
          { type: 'error', code: 'exec_timeout', message: 'timed out' },
          { ...LEGACY_EXIT, code: null, signal: 'SIGTERM' },
        ]),
    });
    const result = await runRemote(harness.ctx, legacyOptions(harness));
    expect(exitCodeOf(result)).toBe(124);
  });

  test('server-side errors keep the legacy error classes', async () => {
    const harness = await setup({
      exec: () => ndjsonResponse([{ type: 'error', code: 'invalid_body', message: 'bad' }]),
    });
    const error = await runRemote(harness.ctx, legacyOptions(harness)).catch((err) => err);
    expect(error).toBeInstanceOf(UsageError);
  });

  test('login, subsystem and pty need a newer node', async () => {
    const harness = await setup();
    const commands: Array<Partial<RemoteRunOptions>> = [
      { command: { kind: 'login' } },
      { command: { kind: 'subsystem', name: 'sftp' } },
      { tty: 'always' },
    ];
    for (const extra of commands) {
      const error = await runRemote(harness.ctx, legacyOptions(harness, extra)).catch((err) => err);
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toContain('目标节点版本过旧，请先升级该节点');
    }
    expect(harness.fixture.posts).toHaveLength(0);
  });

  test('stdin above 740 KiB is refused with the upgrade hint', async () => {
    const harness = await setup({
      terminal: { stdin: Readable.from([Buffer.alloc(800 * 1024, 1)]) },
    });
    const error = await runRemote(harness.ctx, legacyOptions(harness)).catch((err) => err);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('请先升级该节点');
    expect(harness.fixture.posts).toHaveLength(0);
  });

  test('stdin that inflates past the JSON body cap is refused too', async () => {
    const harness = await setup({
      terminal: { stdin: Readable.from([Buffer.alloc(740 * 1024, 0x22)]) },
    });
    const error = await runRemote(harness.ctx, legacyOptions(harness)).catch((err) => err);
    expect(error).toBeInstanceOf(UsageError);
    expect(harness.fixture.posts).toHaveLength(0);
  });

  test('network failures of the legacy stream surface as NetworkError', async () => {
    const harness = await setup({
      exec: () => {
        throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      },
    });
    const error = await runRemote(harness.ctx, legacyOptions(harness)).catch((err) => err);
    expect(error).toBeInstanceOf(NetworkError);
  });
});
