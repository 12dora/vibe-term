// exec 通道客户端：进程内假 EC1 服务端（见 exec-channel-fakes.ts），不走网络。

import { afterEach, describe, expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import {
  EC_ACK_BYTES,
  EC_CHUNK_BYTES,
  EC_HEADER_BYTES,
  EcKind,
  type ExecChannelErrorCode,
  type ExecReady,
  encodeJsonFrame,
} from '@vibeterm/shared/exec-channel';
import {
  AuthError,
  CliError,
  NetworkError,
  NotFoundError,
  PermissionError,
  UsageError,
} from './errors';
import {
  ExecChannelUnsupportedError,
  LocalOutputClosedError,
  runExecChannel,
} from './exec-channel';
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

afterEach(cleanupContexts);

describe('runExecChannel basics', () => {
  test('relays binary stdout/stderr in order and returns the exit code', async () => {
    const { ctx } = await testCtx();
    const outA = Uint8Array.from([0, 255, 10, 13, 128]);
    const outB = textBytes('warn\n');
    const outC = Uint8Array.from([1, 2, 3]);
    const exit = { code: 3, signal: null, reason: 'exit', durationMs: 42 };
    const link = fakeLink((conn) =>
      onHello(conn, () => {
        conn.sendJson(EcKind.READY, readyOf());
        conn.send(EcKind.STDOUT, outA);
        conn.send(EcKind.STDERR, outB);
        conn.send(EcKind.STDOUT, outC);
        conn.sendJson(EcKind.EXIT, exit);
      })
    );
    const { io, writes } = collectIo();
    const plainStdout = io.stdout;
    let first = true;
    io.stdout = async (bytes) => {
      if (first) {
        first = false;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await plainStdout(bytes);
    };
    const readies: ExecReady[] = [];
    const result = await runExecChannel(ctx, 'self', SPEC, io, {
      connect: link.connect,
      timing: FAST,
      onReady: (ready) => readies.push(ready),
    });

    expect(result).toEqual({
      exitCode: 3,
      signal: null,
      reason: 'exit',
      durationMs: 42,
      device: { ...DEVICE },
    });
    expect(readies).toHaveLength(1);
    expect(writes.map((w) => w.fd)).toEqual([1, 2, 1]);
    expect(Array.from(writes[0]?.bytes ?? [])).toEqual(Array.from(outA));
    expect(Array.from(writes[1]?.bytes ?? [])).toEqual(Array.from(outB));
    expect(Array.from(writes[2]?.bytes ?? [])).toEqual(Array.from(outC));

    const conn = link.conns[0] as ServerConn;
    await waitFor(() => conn.has(EcKind.CLOSE));
    expect(conn.hello()).toEqual({ v: 1, op: 'open', spec: SPEC });
    const total =
      outA.length +
      outB.length +
      outC.length +
      3 * EC_HEADER_BYTES +
      encodeJsonFrame(EcKind.EXIT, exit).byteLength;
    const acks = conn.json<{ out: number }>(EcKind.ACK);
    expect(acks.at(-1)?.out).toBe(total);
    const kinds = conn.frames.map((f) => f.kind);
    expect(kinds.slice(-2)).toEqual([EcKind.ACK, EcKind.CLOSE]);
    expect(conn.json<{ kill: boolean }>(EcKind.CLOSE)).toEqual([{ kill: false }]);
  });

  test('sends STDIN_EOF at once when stdin is requested but no source is given', async () => {
    const { ctx } = await testCtx();
    const link = fakeLink((conn) => {
      conn.onFrame = (frame) => {
        if (frame.kind === EcKind.HELLO) conn.sendJson(EcKind.READY, readyOf());
        if (frame.kind === EcKind.STDIN_EOF) conn.sendJson(EcKind.EXIT, EXIT_OK);
      };
    });
    const { io } = collectIo();
    const result = await runExecChannel(ctx, 'self', { ...SPEC, stdin: true }, io, {
      connect: link.connect,
      timing: FAST,
    });
    expect(result.exitCode).toBe(0);
  });

  test('answers PING with PONG and sends its own PING after send-silence', async () => {
    const { ctx } = await testCtx();
    const link = fakeLink((conn) => onHello(conn, () => conn.sendJson(EcKind.READY, readyOf())));
    const { io } = collectIo();
    const run = runExecChannel(ctx, 'self', SPEC, io, {
      connect: link.connect,
      timing: { ...FAST, pingMs: 30, deadMs: 5000 },
    });
    const conn = await waitForConn(link.conns);
    await waitFor(() => conn.has(EcKind.PING));
    conn.send(EcKind.PING);
    await waitFor(() => conn.has(EcKind.PONG));
    conn.sendJson(EcKind.EXIT, EXIT_OK);
    expect((await run).exitCode).toBe(0);
  });
});

describe('stdin flow control', () => {
  test('streams more than the window with STDIN_ACK credit and never exceeds it', async () => {
    const { ctx } = await testCtx();
    const window = 256 * 1024;
    const data = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < data.length; i += 1) data[i] = (i * 31 + 7) & 255;
    const chunks: Buffer[] = [];
    for (let pos = 0; pos < data.length; pos += EC_CHUNK_BYTES) {
      chunks.push(data.subarray(pos, pos + EC_CHUNK_BYTES));
    }
    let received = 0;
    let acked = 0;
    let maxOutstanding = 0;
    const link = fakeLink((conn) => {
      conn.onFrame = (frame) => {
        if (frame.kind === EcKind.HELLO) {
          conn.sendJson(EcKind.READY, readyOf({ window: { stdin: window, out: window } }));
        } else if (frame.kind === EcKind.STDIN) {
          received += frame.payload.byteLength;
          maxOutstanding = Math.max(maxOutstanding, received - acked);
          setTimeout(() => {
            acked = received;
            conn.sendJson(EcKind.STDIN_ACK, { stdin: acked });
          }, 3);
        } else if (frame.kind === EcKind.STDIN_EOF) {
          conn.sendJson(EcKind.EXIT, EXIT_OK);
        }
      };
    });
    const { io } = collectIo({ stdin: Readable.from(chunks) });
    const result = await runExecChannel(ctx, 'self', { ...SPEC, stdin: true }, io, {
      connect: link.connect,
      timing: FAST,
    });
    expect(result.exitCode).toBe(0);
    const conn = link.conns[0] as ServerConn;
    expect(Buffer.from(conn.bytes(EcKind.STDIN)).equals(data)).toBe(true);
    expect(maxOutstanding).toBeLessThanOrEqual(window);
    expect(maxOutstanding).toBeGreaterThan(EC_CHUNK_BYTES);
  });
});

describe('stdin window with oversized chunks', () => {
  test('a single chunk larger than the window is sent only as credit arrives', async () => {
    const { ctx } = await testCtx();
    const window = 128 * 1024;
    const data = Buffer.alloc(700 * 1024);
    for (let i = 0; i < data.length; i += 1) data[i] = (i * 13 + 5) & 255;
    let received = 0;
    let acked = 0;
    let maxOutstanding = 0;
    const link = fakeLink((conn) => {
      conn.onFrame = (frame) => {
        if (frame.kind === EcKind.HELLO) {
          conn.sendJson(EcKind.READY, readyOf({ window: { stdin: window, out: window } }));
        } else if (frame.kind === EcKind.STDIN) {
          received += frame.payload.byteLength;
          maxOutstanding = Math.max(maxOutstanding, received - acked);
          setTimeout(() => {
            acked = received;
            conn.sendJson(EcKind.STDIN_ACK, { stdin: acked });
          }, 3);
        } else if (frame.kind === EcKind.STDIN_EOF) {
          conn.sendJson(EcKind.EXIT, EXIT_OK);
        }
      };
    });
    const { io } = collectIo({ stdin: Readable.from([data]) });
    const result = await runExecChannel(ctx, 'self', { ...SPEC, stdin: true }, io, {
      connect: link.connect,
      timing: FAST,
    });
    expect(result.exitCode).toBe(0);
    const conn = link.conns[0] as ServerConn;
    expect(Buffer.from(conn.bytes(EcKind.STDIN)).equals(data)).toBe(true);
    expect(maxOutstanding).toBeLessThanOrEqual(window);
    expect(maxOutstanding).toBeGreaterThan(EC_CHUNK_BYTES);
  });
});

describe('ACK cadence', () => {
  test('acks at 256 KiB or after the delay, and only for frames already written', async () => {
    const { ctx } = await testCtx();
    const payload = new Uint8Array(EC_CHUNK_BYTES).fill(7);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = true;
    const link = fakeLink((conn) =>
      onHello(conn, () => {
        conn.sendJson(EcKind.READY, readyOf());
        for (let i = 0; i < 4; i += 1) conn.send(EcKind.STDOUT, payload);
      })
    );
    const { io } = collectIo({
      stdout: async () => {
        if (gated) {
          gated = false;
          await gate;
        }
      },
    });
    const run = runExecChannel(ctx, 'self', SPEC, io, { connect: link.connect, timing: FAST });
    const conn = await waitForConn(link.conns);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(conn.has(EcKind.ACK)).toBe(false);

    release();
    const frameBytes = EC_HEADER_BYTES + EC_CHUNK_BYTES;
    await waitFor(() => conn.has(EcKind.ACK));
    expect(frameBytes * 4).toBeGreaterThanOrEqual(EC_ACK_BYTES);
    expect(conn.json<{ out: number }>(EcKind.ACK)).toEqual([{ out: frameBytes * 4 }]);

    conn.send(EcKind.STDOUT, textBytes('hi'));
    await waitFor(() => conn.json(EcKind.ACK).length === 2);
    expect(conn.json<{ out: number }>(EcKind.ACK)[1]).toEqual({
      out: frameBytes * 4 + EC_HEADER_BYTES + 2,
    });

    conn.sendJson(EcKind.EXIT, EXIT_OK);
    await run;
    await waitFor(() => conn.has(EcKind.CLOSE));
    expect(conn.json(EcKind.ACK).length).toBe(3);
  });
});

describe('error mapping', () => {
  const cases: Array<[ExecChannelErrorCode, new (...args: never[]) => Error, number]> = [
    ['device_not_found', NotFoundError, 4],
    ['invalid_request', UsageError, 2],
    ['forbidden', PermissionError, 1],
    ['exec_unsupported_device', CliError, 1],
    ['exec_spawn_failed', CliError, 1],
    ['pty_unsupported', CliError, 1],
    ['session_limit', CliError, 1],
    ['session_not_found', NotFoundError, 4],
    ['protocol_error', NetworkError, 5],
  ];
  for (const [code, errorClass, exitCode] of cases) {
    test(`ERROR ${code} maps to ${errorClass.name}`, async () => {
      const { ctx } = await testCtx();
      const link = fakeLink((conn) =>
        onHello(conn, () => {
          conn.sendJson(EcKind.ERROR, { code, message: `server says ${code}` });
          conn.drop(1000);
        })
      );
      const { io } = collectIo();
      const error = await runExecChannel(ctx, 'self', SPEC, io, {
        connect: link.connect,
        timing: FAST,
      }).catch((err) => err);
      expect(error).toBeInstanceOf(errorClass);
      expect((error as CliError).exitCode).toBe(exitCode);
      if (code !== 'session_not_found') {
        expect((error as Error).message).toBe(`server says ${code}`);
      }
      expect(link.conns).toHaveLength(1);
    });
  }

  test('output received before an ERROR frame is still written first', async () => {
    const { ctx } = await testCtx();
    const link = fakeLink((conn) =>
      onHello(conn, () => {
        conn.sendJson(EcKind.READY, readyOf());
        conn.send(EcKind.STDOUT, textBytes('partial'));
        conn.sendJson(EcKind.ERROR, { code: 'protocol_error', message: 'boom' });
      })
    );
    const { io, writes } = collectIo();
    const error = await runExecChannel(ctx, 'self', SPEC, io, {
      connect: link.connect,
      timing: FAST,
    }).catch((err) => err);
    expect(error).toBeInstanceOf(NetworkError);
    expect(writes).toHaveLength(1);
  });

  test('malformed EXIT JSON becomes a NetworkError', async () => {
    const { ctx } = await testCtx();
    const link = fakeLink((conn) =>
      onHello(conn, () => {
        conn.sendJson(EcKind.READY, readyOf());
        conn.send(EcKind.EXIT, textBytes('not json'));
      })
    );
    const { io } = collectIo();
    const error = await runExecChannel(ctx, 'self', SPEC, io, {
      connect: link.connect,
      timing: FAST,
    }).catch((err) => err);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toContain('protocol error');
  });

  test('EPIPE from the local writer kills the session (LocalOutputClosedError)', async () => {
    const { ctx } = await testCtx();
    const link = fakeLink((conn) =>
      onHello(conn, () => {
        conn.sendJson(EcKind.READY, readyOf());
        conn.send(EcKind.STDOUT, textBytes('x'));
      })
    );
    const { io } = collectIo({
      stdout: () => {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      },
    });
    const error = await runExecChannel(ctx, 'self', SPEC, io, {
      connect: link.connect,
      timing: FAST,
    }).catch((err) => err);
    expect(error).toBeInstanceOf(LocalOutputClosedError);
    const conn = link.conns[0] as ServerConn;
    await waitFor(() => conn.has(EcKind.CLOSE));
    expect(conn.json(EcKind.CLOSE)).toEqual([{ kill: true }]);
  });

  const closes: Array<[number, new (...args: never[]) => Error]> = [
    [4404, ExecChannelUnsupportedError],
    [4401, AuthError],
    [4403, PermissionError],
    [4409, NetworkError],
    [1006, NetworkError],
  ];
  for (const [code, errorClass] of closes) {
    test(`close code ${code} maps to ${errorClass.name}`, async () => {
      const { ctx } = await testCtx();
      const link = fakeLink((conn) => conn.drop(code, ''));
      const { io } = collectIo();
      const error = await runExecChannel(ctx, 'self', SPEC, io, {
        connect: link.connect,
        timing: FAST,
      }).catch((err) => err);
      expect(error).toBeInstanceOf(errorClass);
      expect(link.conns).toHaveLength(1);
      if (code === 4401) expect((error as AuthError).hint).toBe('run: vibeterm login');
    });
  }
});
