// exec 通道：非 PTY SIGTERM / SIGHUP 的转发 + 宽限杀会话，以及断线错误文案。

import { afterEach, describe, expect, test } from 'bun:test';
import { EcKind } from '@vibeterm/shared/exec-channel';
import { NetworkError } from './errors';
import { exitCodeOf, runExecChannel } from './exec-channel';
import {
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
  waitFor,
} from './exec-channel-fakes';
import { assertRetryable } from './exec-channel-retry';

afterEach(cleanupContexts);

async function startRun(termGraceMs: number) {
  const { ctx } = await testCtx();
  const link = fakeLink((conn) => onHello(conn, () => conn.sendJson(EcKind.READY, readyOf())));
  const { io } = collectIo();
  let ready = false;
  const run = runExecChannel(ctx, 'self', SPEC, io, {
    connect: link.connect,
    timing: { ...FAST, termGraceMs },
    onReady: () => {
      ready = true;
    },
  });
  await waitFor(() => ready);
  return { run, conn: link.conns[0] as ServerConn };
}

describe('SIGTERM / SIGHUP grace (non-PTY)', () => {
  test('SIGTERM is forwarded, then the session is killed when the remote ignores it', async () => {
    const { run, conn } = await startRun(60);
    process.emit('SIGTERM', 'SIGTERM');
    await waitFor(() => conn.has(EcKind.SIGNAL));
    expect(conn.json(EcKind.SIGNAL)).toEqual([{ signal: 'SIGTERM' }]);
    expect(conn.has(EcKind.CLOSE)).toBe(false);
    const result = await run;
    expect(result).toMatchObject({ signal: 'SIGTERM', reason: 'killed' });
    expect(exitCodeOf(result)).toBe(143);
    await waitFor(() => conn.has(EcKind.CLOSE));
    expect(conn.json(EcKind.CLOSE)).toEqual([{ kill: true }]);
  });

  test('SIGHUP ends with 129 after the grace', async () => {
    const { run, conn } = await startRun(40);
    process.emit('SIGHUP', 'SIGHUP');
    const result = await run;
    expect(exitCodeOf(result)).toBe(129);
    expect(conn.json(EcKind.SIGNAL)).toEqual([{ signal: 'SIGHUP' }]);
    await waitFor(() => conn.has(EcKind.CLOSE));
    expect(conn.json(EcKind.CLOSE)).toEqual([{ kill: true }]);
  });

  test('a remote that exits within the grace keeps its own result', async () => {
    const { run, conn } = await startRun(300);
    process.emit('SIGTERM', 'SIGTERM');
    await waitFor(() => conn.has(EcKind.SIGNAL));
    conn.sendJson(EcKind.EXIT, { ...EXIT_OK, code: null, signal: 'SIGTERM', reason: 'killed' });
    const result = await run;
    expect(result).toMatchObject({ exitCode: null, signal: 'SIGTERM', reason: 'killed' });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(conn.json(EcKind.CLOSE)).toEqual([{ kill: false }]);
  });

  test('SIGINT is forwarded without any timed kill', async () => {
    const { run, conn } = await startRun(30);
    process.emit('SIGINT', 'SIGINT');
    await waitFor(() => conn.has(EcKind.SIGNAL));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(conn.has(EcKind.CLOSE)).toBe(false);
    process.emit('SIGINT', 'SIGINT');
    expect(exitCodeOf(await run)).toBe(130);
  });

  test('a second signal during the grace kills immediately', async () => {
    const { run, conn } = await startRun(60_000);
    process.emit('SIGTERM', 'SIGTERM');
    await waitFor(() => conn.has(EcKind.SIGNAL));
    process.emit('SIGINT', 'SIGINT');
    const result = await run;
    expect(exitCodeOf(result)).toBe(130);
    await waitFor(() => conn.has(EcKind.CLOSE));
    expect(conn.json(EcKind.CLOSE)).toEqual([{ kill: true }]);
  });
});

describe('assertRetryable messages', () => {
  const entry = 'http://entry.example:9883';

  test('unreachable names the entry and node, without the raw close code', () => {
    const lost = { kind: 'lost', code: 1006, reason: '', opened: false } as const;
    let error: unknown;
    try {
      assertRetryable(entry, 'self', lost, false);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toBe(`cannot reach ${entry} (node self)`);
  });

  test('a close before the session started keeps the gateway reason', () => {
    const lost = { kind: 'lost', code: 1006, reason: 'bad gateway', opened: true } as const;
    expect(() => assertRetryable(entry, 'n1', lost, false)).toThrow(
      `connection to ${entry} (node n1) closed before the session started: bad gateway`
    );
  });

  test('an established session just reconnects', () => {
    const lost = { kind: 'lost', code: 1006, reason: '', opened: true } as const;
    expect(() => assertRetryable(entry, 'self', lost, true)).not.toThrow();
  });
});
