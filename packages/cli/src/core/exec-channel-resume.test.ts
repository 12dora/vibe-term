// exec 通道客户端：断线重连 / resume、信号、PTY 与辅助函数。

import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import {
  EcKind,
  type ExecHello,
  type ExecOpenSpec,
  decodeJson,
  encodeFrame,
  encodeJsonFrame,
} from '@vibeterm/shared/exec-channel';
import { NetworkError, NotFoundError } from './errors';
import { ExecChannelUnsupportedError, exitCodeOf, runExecChannel } from './exec-channel';
import {
  DEVICE,
  EXIT_OK,
  FAST,
  SPEC,
  type ServerConn,
  cleanupContexts,
  collectIo,
  fakeLink,
  onHello,
  readyOf,
  testCtx,
  textBytes,
  waitFor,
  waitForConn,
} from './exec-channel-fakes';
import type { ExecChannelResult } from './exec-channel-result';
import { execSocketTarget, execWsUrl } from './exec-channel-socket';

afterEach(cleanupContexts);

describe('reconnect and resume', () => {
  test('resumes at the exact out offset and re-sends stdin the node did not accept', async () => {
    const { ctx } = await testCtx();
    const outA = Uint8Array.from([0xff, 0, 1]);
    const outB = textBytes('second');
    const outC = Uint8Array.from([9, 8, 7]);
    const frameA = encodeFrame(EcKind.STDOUT, outA);
    const frameB = encodeFrame(EcKind.STDERR, outB);
    const frameC = encodeFrame(EcKind.STDOUT, outC);
    const frameExit = encodeJsonFrame(EcKind.EXIT, EXIT_OK);
    const log = [frameA, frameB, frameC, frameExit];
    const s1 = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
    const s2 = Buffer.from(Array.from({ length: 50 }, (_, i) => 200 + i));
    const stdin = new PassThrough();
    stdin.write(s1);
    let firstStdin = 0;
    let dropped = false;
    const link = fakeLink((conn) => {
      conn.onFrame = (frame) => {
        if (frame.kind === EcKind.HELLO) {
          const hello = decodeJson<ExecHello>(frame.payload);
          if (conn.index === 0) {
            conn.sendJson(EcKind.READY, readyOf());
            conn.sendRaw(frameA);
            conn.sendRaw(frameB.subarray(0, 4));
            return;
          }
          if (hello.op !== 'resume') throw new Error('expected resume');
          conn.sendJson(EcKind.READY, readyOf({ resumed: true, out: hello.out, stdin: 40 }));
          let offset = 0;
          for (const piece of log) {
            if (offset >= hello.out) conn.sendRaw(piece);
            offset += piece.byteLength;
          }
        } else if (conn.index === 0 && frame.kind === EcKind.STDIN) {
          firstStdin += frame.payload.byteLength;
          if (firstStdin < s1.length || dropped) return;
          dropped = true;
          stdin.end(s2);
          conn.drop(1006);
        }
      };
    });
    const { io, writes } = collectIo({ stdin });
    const result = await runExecChannel(ctx, 'self', { ...SPEC, stdin: true }, io, {
      connect: link.connect,
      timing: FAST,
    });

    expect(result.exitCode).toBe(0);
    expect(link.conns).toHaveLength(2);
    expect(link.conns[1]?.hello()).toEqual({
      v: 1,
      op: 'resume',
      sessionId: 's'.repeat(32),
      out: frameA.byteLength,
    });
    expect(writes.map((w) => [w.fd, Array.from(w.bytes)])).toEqual([
      [1, Array.from(outA)],
      [2, Array.from(outB)],
      [1, Array.from(outC)],
    ]);
    const second = link.conns[1] as ServerConn;
    await waitFor(() => second.has(EcKind.CLOSE));
    const expectedStdin = Buffer.concat([s1, s2]).subarray(40);
    expect(Buffer.from(second.bytes(EcKind.STDIN)).equals(expectedStdin)).toBe(true);
    expect(second.has(EcKind.STDIN_EOF)).toBe(true);
    expect(second.json<{ out: number }>(EcKind.ACK).at(0)?.out).toBe(frameA.byteLength);
  });

  for (const code of ['session_not_found', 'resume_gap'] as const) {
    test(`resume refused with ${code} becomes a concise NotFoundError`, async () => {
      const { ctx } = await testCtx();
      const link = fakeLink((conn) =>
        onHello(conn, () => {
          if (conn.index === 0) {
            conn.sendJson(EcKind.READY, readyOf());
            conn.send(EcKind.STDOUT, textBytes('first'));
            conn.drop(1006);
            return;
          }
          conn.sendJson(EcKind.ERROR, { code, message: 'gone' });
          conn.drop(1000);
        })
      );
      const { io, writes } = collectIo();
      const error = await runExecChannel(ctx, 'self', SPEC, io, {
        connect: link.connect,
        timing: FAST,
      }).catch((err) => err);
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as Error).message).toContain('remote session has ended');
      expect(writes).toHaveLength(1);
    });
  }

  test('gives up after the grace; prints one line per attempt only with verbose', async () => {
    const run = async (verbose: boolean) => {
      const { ctx, stderr } = await testCtx();
      const link = fakeLink((conn) =>
        onHello(conn, () => {
          if (conn.index === 0) conn.sendJson(EcKind.READY, readyOf());
          conn.drop(1006);
        })
      );
      const { io } = collectIo();
      const error = await runExecChannel(ctx, 'self', { ...SPEC, detachGraceMs: 120 }, io, {
        connect: link.connect,
        timing: { ...FAST, backoffMs: [10] },
        verbose,
      }).catch((err) => err);
      return { error, text: stderr(), attempts: link.conns.length };
    };
    const quiet = await run(false);
    expect(quiet.error).toBeInstanceOf(NetworkError);
    expect((quiet.error as Error).message).toContain('gave up reconnecting');
    expect(quiet.text).toBe('');
    expect(quiet.attempts).toBeGreaterThan(2);

    const loud = await run(true);
    const lines = loud.text.trim().split('\n');
    expect(lines.length).toBe(loud.attempts - 1);
    expect(lines[0]).toContain('reconnecting (attempt 1)');
  });

  test('a silent link is declared dead and the session is resumed', async () => {
    const { ctx } = await testCtx();
    const link = fakeLink((conn) =>
      onHello(conn, () => {
        if (conn.index === 0) {
          conn.sendJson(EcKind.READY, readyOf());
          return;
        }
        conn.sendJson(EcKind.READY, readyOf({ resumed: true }));
        conn.sendJson(EcKind.EXIT, EXIT_OK);
      })
    );
    const { io } = collectIo();
    const result = await runExecChannel(ctx, 'self', SPEC, io, {
      connect: link.connect,
      timing: { ...FAST, pingMs: 20, deadMs: 120 },
    });
    expect(result.exitCode).toBe(0);
    expect(link.conns).toHaveLength(2);
    expect(link.conns[1]?.hello()?.op).toBe('resume');
  });
});

describe('close 4404 after READY', () => {
  test('is a retryable loss, never ExecChannelUnsupportedError', async () => {
    const { ctx } = await testCtx();
    const link = fakeLink((conn) =>
      onHello(conn, () => {
        if (conn.index === 0) {
          conn.sendJson(EcKind.READY, readyOf());
          conn.drop(1006);
        } else if (conn.index === 1) {
          conn.drop(4404);
        } else {
          conn.sendJson(EcKind.READY, readyOf({ resumed: true }));
          conn.sendJson(EcKind.EXIT, EXIT_OK);
        }
      })
    );
    const { io } = collectIo();
    const result = await runExecChannel(ctx, 'self', SPEC, io, {
      connect: link.connect,
      timing: FAST,
    });
    expect(result.exitCode).toBe(0);
    expect(link.conns).toHaveLength(3);
  });

  test('ends as NetworkError when the budget runs out', async () => {
    const { ctx } = await testCtx();
    const link = fakeLink((conn) =>
      onHello(conn, () => {
        if (conn.index === 0) conn.sendJson(EcKind.READY, readyOf());
        conn.drop(conn.index === 0 ? 1006 : 4404);
      })
    );
    const { io } = collectIo();
    const error = await runExecChannel(ctx, 'self', { ...SPEC, detachGraceMs: 100 }, io, {
      connect: link.connect,
      timing: FAST,
    }).catch((err) => err);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).not.toBeInstanceOf(ExecChannelUnsupportedError);
  });
});

describe('signals and pty', () => {
  test('first signal is forwarded, the second kills and maps to 128+signo', async () => {
    const { ctx } = await testCtx();
    const link = fakeLink((conn) => onHello(conn, () => conn.sendJson(EcKind.READY, readyOf())));
    const { io } = collectIo();
    let ready = false;
    const run = runExecChannel(ctx, 'self', SPEC, io, {
      connect: link.connect,
      timing: FAST,
      onReady: () => {
        ready = true;
      },
    });
    await waitFor(() => ready);
    const conn = link.conns[0] as ServerConn;
    process.emit('SIGINT', 'SIGINT');
    await waitFor(() => conn.has(EcKind.SIGNAL));
    expect(conn.json(EcKind.SIGNAL)).toEqual([{ signal: 'SIGINT' }]);
    process.emit('SIGINT', 'SIGINT');
    const result = await run;
    expect(result).toMatchObject({ exitCode: null, signal: 'SIGINT', reason: 'killed' });
    expect(exitCodeOf(result)).toBe(130);
    await waitFor(() => conn.has(EcKind.CLOSE));
    expect(conn.json(EcKind.CLOSE)).toEqual([{ kill: true }]);
  });

  test('pty mode: raw mode, keystrokes, resize, and tty restore', async () => {
    const harness = await ptyHarness();
    const { run, conn, input, output, rawCalls } = harness;
    input.write('ls\r');
    await waitFor(() => conn().bytes(EcKind.STDIN).byteLength === 3);
    expect(Buffer.from(conn().bytes(EcKind.STDIN)).toString()).toBe('ls\r');
    output.emit('resize');
    await waitFor(() => conn().has(EcKind.RESIZE));
    expect(conn().json(EcKind.RESIZE)).toEqual([{ cols: 100, rows: 30 }]);
    conn().sendJson(EcKind.EXIT, EXIT_OK);
    await run;
    expect(rawCalls).toEqual([true, false]);
  });

  test('pty mode: SIGTERM kills the session, restores the tty and maps to 143', async () => {
    const harness = await ptyHarness();
    process.emit('SIGTERM', 'SIGTERM');
    const result = await harness.run;
    expect(result).toMatchObject({ signal: 'SIGTERM', reason: 'killed' });
    expect(exitCodeOf(result)).toBe(143);
    await waitFor(() => harness.conn().has(EcKind.CLOSE));
    expect(harness.conn().json(EcKind.CLOSE)).toEqual([{ kill: true }]);
    expect(harness.conn().has(EcKind.SIGNAL)).toBe(false);
    expect(harness.rawCalls).toEqual([true, false]);
  });
});

async function ptyHarness() {
  const { ctx } = await testCtx();
  const rawCalls: boolean[] = [];
  const input = Object.assign(new PassThrough(), {
    isRaw: false,
    setRawMode(mode: boolean) {
      rawCalls.push(mode);
      return input;
    },
  });
  const output = Object.assign(new EventEmitter(), { columns: 100, rows: 30 });
  const link = fakeLink((conn) =>
    onHello(conn, () => conn.sendJson(EcKind.READY, readyOf({ pty: true })))
  );
  const { io } = collectIo({
    tty: { input: input as unknown as ReadStream, output: output as unknown as WriteStream },
  });
  let ready = false;
  const spec: ExecOpenSpec = {
    command: { kind: 'login' },
    stdin: true,
    pty: { cols: 80, rows: 24 },
  };
  const run = runExecChannel(ctx, 'self', spec, io, {
    connect: link.connect,
    timing: FAST,
    onReady: () => {
      ready = true;
    },
  });
  await waitFor(() => ready);
  return { run, input, output, rawCalls, conn: () => link.conns[0] as ServerConn };
}

describe('kill delivery while the link is down or not ready', () => {
  test('a second signal during reconnect resumes once to deliver CLOSE{kill:true}', async () => {
    const { ctx } = await testCtx();
    const link = fakeLink((conn) =>
      onHello(conn, () => {
        conn.sendJson(EcKind.READY, readyOf({ resumed: conn.index > 0 }));
        if (conn.index === 0) conn.drop(1006);
      })
    );
    const { io } = collectIo();
    let ready = false;
    const run = runExecChannel(ctx, 'self', SPEC, io, {
      connect: link.connect,
      timing: { ...FAST, backoffMs: [300] },
      onReady: () => {
        ready = true;
      },
    });
    await waitFor(() => ready);
    await new Promise((resolve) => setTimeout(resolve, 40));
    process.emit('SIGINT', 'SIGINT');
    process.emit('SIGINT', 'SIGINT');
    const result = await run;
    expect(exitCodeOf(result)).toBe(130);
    const resumed = link.conns[1] as ServerConn;
    expect(resumed.hello()?.op).toBe('resume');
    await waitFor(() => resumed.has(EcKind.CLOSE));
    expect(resumed.json(EcKind.CLOSE)).toEqual([{ kill: true }]);
  });

  test('a signal while READY is in flight still delivers CLOSE{kill:true}', async () => {
    const { ctx } = await testCtx();
    const link = fakeLink((conn) =>
      onHello(conn, () => {
        setTimeout(() => conn.sendJson(EcKind.READY, readyOf()), 40);
      })
    );
    const { io } = collectIo();
    const run = runExecChannel(ctx, 'self', SPEC, io, { connect: link.connect, timing: FAST });
    const conn = await waitForConn(link.conns);
    await waitFor(() => conn.has(EcKind.HELLO));
    process.emit('SIGTERM', 'SIGTERM');
    const result = await run;
    expect(exitCodeOf(result)).toBe(143);
    await waitFor(() => conn.has(EcKind.CLOSE));
    expect(conn.json(EcKind.CLOSE)).toEqual([{ kill: true }]);
  });
});

describe('helpers', () => {
  test('exitCodeOf maps reason, signal and code', () => {
    const base: ExecChannelResult = {
      exitCode: 0,
      signal: null,
      reason: 'exit',
      durationMs: 1,
      device: { ...DEVICE },
    };
    expect(exitCodeOf(base)).toBe(0);
    expect(exitCodeOf({ ...base, exitCode: 7 })).toBe(7);
    expect(exitCodeOf({ ...base, exitCode: null })).toBe(255);
    expect(exitCodeOf({ ...base, exitCode: null, reason: 'timeout' })).toBe(124);
    expect(exitCodeOf({ ...base, exitCode: null, signal: 'SIGINT', reason: 'killed' })).toBe(130);
    expect(exitCodeOf({ ...base, exitCode: null, signal: 'SIGTERM', reason: 'killed' })).toBe(143);
    expect(exitCodeOf({ ...base, exitCode: null, signal: 'SIGKILL', reason: 'killed' })).toBe(137);
    expect(exitCodeOf({ ...base, exitCode: null, signal: 'SIGHUP', reason: 'killed' })).toBe(129);
  });

  test('execWsUrl keeps the node prefix and maps the scheme', () => {
    expect(execWsUrl('http://entry:9883', 'self')).toBe('ws://entry:9883/api/exec/ws');
    expect(execWsUrl('https://entry', 'a'.repeat(32))).toBe(
      `wss://entry/n/${'a'.repeat(32)}/api/exec/ws`
    );
  });

  test('execSocketTarget carries the entry origin and the session cookie', async () => {
    const { ctx } = await testCtx();
    ctx.http.jar.set('self', 'sid-1', 0);
    const target = execSocketTarget(ctx, 'self');
    expect(target.url).toBe('ws://entry.example:9883/api/exec/ws');
    expect(target.headers.origin).toBe('http://entry.example:9883');
    expect(target.headers.cookie).toContain('vibeterm_s_self=sid-1');
  });
});
