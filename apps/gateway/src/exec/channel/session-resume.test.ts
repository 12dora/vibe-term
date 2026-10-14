import { afterEach, describe, expect, test } from 'bun:test';
import {
  EC_CHUNK_BYTES,
  EC_WINDOW_BYTES,
  EcKind,
  type ExecExit,
  type ExecReady,
  encodeFrame,
} from '@vibeterm/shared/exec-channel';
import { createClock } from './deps';
import { liveSessionCount, resetExecRegistryForTests } from './registry';
import { type TestEnv, bytes, connect, flush, makeEnv, openSession, text } from './test-harness';

afterEach(() => resetExecRegistryForTests());

const errorOf = (t: { json<T>(kind: number): T[] }) =>
  t.json<{ code: string; message: string }>(EcKind.ERROR)[0];

async function resumeClient(env: TestEnv, sessionId: string, out: number, uid = 'u1') {
  const client = connect(env, { uid, tokenId: null });
  client.send(EcKind.HELLO, { v: 1, op: 'resume', sessionId, out });
  await flush();
  return client;
}

describe('detach and resume', () => {
  test('replays retained output byte-exactly from the requested offset', async () => {
    const env = makeEnv();
    const { client, proc, sessionId } = await openSession(env);
    proc.stdout('AAAA');
    proc.stdout('BBBB');
    await flush();
    client.inbound.onClose();
    const tail = new Uint8Array(200_000).map((_, i) => (i * 7) % 256);
    proc.stdout(tail);
    proc.stderr('err');
    await flush();
    const resumed = await resumeClient(env, sessionId, 9);
    const ready = resumed.transport.json<ExecReady>(EcKind.READY)[0] as ExecReady;
    expect(ready).toMatchObject({ resumed: true, out: 9 });
    expect(resumed.transport.frames[0]?.kind).toBe(EcKind.READY);
    const expected = new Uint8Array([...bytes('BBBB'), ...tail]);
    expect(resumed.transport.concat(EcKind.STDOUT)).toEqual(expected);
    expect(text(resumed.transport.concat(EcKind.STDERR))).toBe('err');
  });

  test('continues live output after resume', async () => {
    const env = makeEnv();
    const { client, proc, sessionId } = await openSession(env);
    client.inbound.onClose();
    const resumed = await resumeClient(env, sessionId, 0);
    proc.stdout('live');
    await flush();
    expect(text(resumed.transport.concat(EcKind.STDOUT))).toBe('live');
  });

  test('resume_gap for offsets outside the retained range or off frame boundaries', async () => {
    const env = makeEnv();
    const { client, proc, sessionId } = await openSession(env);
    proc.stdout('AAAA');
    proc.stdout('BBBB');
    await flush();
    client.send(EcKind.ACK, { out: 9 });
    client.inbound.onClose();
    for (const out of [0, 3, 10, 19, 999_999]) {
      const resumed = await resumeClient(env, sessionId, out);
      expect(errorOf(resumed.transport)?.code).toBe('resume_gap');
    }
    const ok = await resumeClient(env, sessionId, 18);
    expect(ok.transport.json<ExecReady>(EcKind.READY)[0]).toMatchObject({ resumed: true, out: 18 });
  });

  test('uid mismatch and unknown ids look the same: session_not_found', async () => {
    const env = makeEnv();
    const { sessionId } = await openSession(env);
    const stranger = await resumeClient(env, sessionId, 0, 'u2');
    expect(errorOf(stranger.transport)?.code).toBe('session_not_found');
    const unknown = await resumeClient(env, '0'.repeat(32), 0);
    expect(errorOf(unknown.transport)?.code).toBe('session_not_found');
    const anonymous = connect(env, { uid: null, tokenId: null });
    anonymous.send(EcKind.HELLO, { v: 1, op: 'resume', sessionId, out: 0 });
    expect(errorOf(anonymous.transport)?.code).toBe('session_not_found');
  });

  test('takeover closes the attached transport with 4409 and the old close is inert', async () => {
    const env = makeEnv();
    const { client, proc, sessionId } = await openSession(env, { detachGraceMs: 500 });
    const taker = await resumeClient(env, sessionId, 0);
    expect(client.transport.closed?.code).toBe(4409);
    client.inbound.onClose();
    await env.clock.advance(1000);
    expect(proc.killCount).toBe(0);
    proc.stdout('x');
    await flush();
    expect(text(taker.transport.concat(EcKind.STDOUT))).toBe('x');
  });

  test('grace expiry sends SIGHUP then kills, and the session is gone', async () => {
    const env = makeEnv();
    const { client, proc, sessionId } = await openSession(env, { detachGraceMs: 1000 });
    client.inbound.onClose();
    await env.clock.advance(999);
    expect(proc.killCount).toBe(0);
    await env.clock.advance(1);
    expect(proc.signals).toEqual(['SIGHUP']);
    expect(proc.killCount).toBe(1);
    expect(liveSessionCount()).toBe(0);
    const late = await resumeClient(env, sessionId, 0);
    expect(errorOf(late.transport)?.code).toBe('session_not_found');
  });

  test('resume cancels the grace timer', async () => {
    const env = makeEnv();
    const { client, proc, sessionId } = await openSession(env, { detachGraceMs: 1000 });
    client.inbound.onClose();
    await env.clock.advance(500);
    await resumeClient(env, sessionId, 0);
    await env.clock.advance(5000);
    expect(proc.killCount).toBe(0);
  });

  test('exited session is disposed when grace expires while detached', async () => {
    const env = makeEnv();
    const { client, proc } = await openSession(env, { detachGraceMs: 1000 });
    proc.finish(0);
    await flush();
    client.inbound.onClose();
    await env.clock.advance(1000);
    expect(liveSessionCount()).toBe(0);
    expect(proc.killCount).toBe(0);
  });

  test('timeout kills the process and reports EXIT reason timeout', async () => {
    const env = makeEnv();
    const { client, proc } = await openSession(env, { timeoutMs: 5000 });
    await env.clock.advance(4999);
    expect(proc.killCount).toBe(0);
    await env.clock.advance(1);
    expect(proc.killCount).toBe(1);
    const exit = client.transport.json<ExecExit>(EcKind.EXIT)[0] as ExecExit;
    expect(exit).toMatchObject({ reason: 'timeout', signal: 'SIGTERM' });
  });

  test('a 30-day timeout is armed in steps within the 2^31-1 ms timer cap', async () => {
    const env = makeEnv();
    const delays: number[] = [];
    env.deps.clock = createClock(
      {
        setTimeout: (fn, ms) => {
          delays.push(ms);
          return env.clock.setTimeout(fn, ms);
        },
        clearTimeout: (handle) => env.clock.clearTimeout(handle),
      },
      () => env.clock.now()
    );
    const { proc } = await openSession(env, { timeoutMs: 30 * 24 * 3600 * 1000 });
    expect(delays).toContain(2 ** 31 - 1);
    expect(Math.max(...delays)).toBeLessThanOrEqual(2 ** 31 - 1);
    await env.clock.advance(10_000);
    expect(proc.killCount).toBe(0);
  });
});

describe('stdin', () => {
  const stdinFrame = (client: ReturnType<typeof connect>, data: Uint8Array) =>
    client.inbound.onBytes(encodeFrame(EcKind.STDIN, data));
  const acks = (client: ReturnType<typeof connect>) =>
    client.transport.json<{ stdin: number }>(EcKind.STDIN_ACK).map((a) => a.stdin);

  test('writes in order, acks once when the queue drains, EOF waits for the writes', async () => {
    const { client, proc } = await openSession(makeEnv());
    let release!: () => void;
    proc.writeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stdinFrame(client, bytes('ab'));
    stdinFrame(client, bytes('cd'));
    client.send(EcKind.STDIN_EOF);
    await flush();
    expect(proc.stdinWrites).toHaveLength(0);
    expect(proc.stdinEnded).toBe(false);
    release();
    await flush();
    expect(proc.stdinWrites.map(text)).toEqual(['ab', 'cd']);
    expect(proc.stdinEnded).toBe(true);
    expect(acks(client)).toEqual([4]);
  });

  test('coalesces STDIN_ACK per 64 KiB', async () => {
    const { client } = await openSession(makeEnv());
    for (let i = 0; i < 3; i++) stdinFrame(client, new Uint8Array(40_000));
    await flush();
    expect(acks(client)).toEqual([80_000, 120_000]);
  });

  test('STDIN after STDIN_EOF is a protocol error', async () => {
    const { client } = await openSession(makeEnv());
    client.send(EcKind.STDIN_EOF);
    stdinFrame(client, bytes('x'));
    expect(errorOf(client.transport)?.code).toBe('protocol_error');
  });

  test('stdin beyond window + one chunk of unwritten bytes is a protocol error', async () => {
    const { client, proc } = await openSession(makeEnv());
    proc.writeGate = new Promise<void>(() => undefined);
    const frames = EC_WINDOW_BYTES / EC_CHUNK_BYTES + 1;
    for (let i = 0; i < frames; i++) stdinFrame(client, new Uint8Array(EC_CHUNK_BYTES));
    expect(errorOf(client.transport)).toBeUndefined();
    stdinFrame(client, bytes('x'));
    expect(errorOf(client.transport)?.code).toBe('protocol_error');
    expect(errorOf(client.transport)?.message).toContain('window');
  });

  test('resume reports the committed offset and drops unwritten queued stdin', async () => {
    const env = makeEnv();
    const { client, proc, sessionId } = await openSession(env);
    let release!: () => void;
    proc.writeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stdinFrame(client, bytes('ab'));
    stdinFrame(client, bytes('cd'));
    stdinFrame(client, bytes('ef'));
    client.send(EcKind.STDIN_EOF);
    client.inbound.onClose();
    const resumed = await resumeClient(env, sessionId, 0);
    expect(resumed.transport.json<ExecReady>(EcKind.READY)[0]).toMatchObject({
      stdin: 2,
      stdinClosed: false,
    });
    release();
    await flush();
    stdinFrame(resumed, bytes('cdef'));
    resumed.send(EcKind.STDIN_EOF);
    await flush();
    expect(proc.stdinWrites.map(text)).toEqual(['ab', 'cdef']);
    expect(proc.stdinEnded).toBe(true);
    expect(acks(resumed).at(-1)).toBe(6);
  });

  test('READY after resume reports accepted stdin and EOF state', async () => {
    const env = makeEnv();
    const { client, sessionId } = await openSession(env);
    stdinFrame(client, bytes('hello'));
    client.send(EcKind.STDIN_EOF);
    client.inbound.onClose();
    const resumed = await resumeClient(env, sessionId, 0);
    expect(resumed.transport.json<ExecReady>(EcKind.READY)[0]).toMatchObject({
      stdin: 5,
      stdinClosed: true,
    });
  });
});

describe('CLOSE', () => {
  test('kill:true kills, disposes and sends no EXIT', async () => {
    const env = makeEnv();
    const { client, proc, sessionId } = await openSession(env);
    client.send(EcKind.CLOSE, { kill: true });
    await flush();
    expect(proc.killCount).toBe(1);
    expect(client.transport.closed?.code).toBe(1000);
    expect(client.transport.ofKind(EcKind.EXIT)).toHaveLength(0);
    const late = await resumeClient(env, sessionId, 0);
    expect(errorOf(late.transport)?.code).toBe('session_not_found');
  });

  test('kill:false after EXIT disposes', async () => {
    const { client, proc } = await openSession(makeEnv());
    proc.finish(0);
    await flush();
    client.send(EcKind.CLOSE, { kill: false });
    expect(liveSessionCount()).toBe(0);
  });

  test('kill:false while running only detaches', async () => {
    const { client, proc } = await openSession(makeEnv());
    client.send(EcKind.CLOSE, { kill: false });
    expect(client.transport.closed?.code).toBe(1000);
    expect(proc.killCount).toBe(0);
    expect(liveSessionCount()).toBe(1);
  });
});

describe('liveness', () => {
  test('answers PING with PONG', async () => {
    const { client } = await openSession(makeEnv());
    client.send(EcKind.PING);
    expect(client.transport.ofKind(EcKind.PONG)).toHaveLength(1);
  });

  test('sends PING after 15 s of silence; idle transport is detached and closed with 4408 after 45 s', async () => {
    const env = makeEnv();
    const { client } = await openSession(env);
    await env.clock.advance(14_000);
    expect(client.transport.ofKind(EcKind.PING)).toHaveLength(0);
    await env.clock.advance(1000);
    expect(client.transport.ofKind(EcKind.PING)).toHaveLength(1);
    await env.clock.advance(30_000);
    expect(client.transport.closed).toEqual({ code: 4408, reason: 'idle' });
    expect(liveSessionCount()).toBe(1);
  });

  test('inbound frames postpone the idle deadline', async () => {
    const env = makeEnv();
    const { client } = await openSession(env);
    await env.clock.advance(40_000);
    client.send(EcKind.PING);
    await env.clock.advance(40_000);
    expect(client.transport.closed).toBeNull();
    await env.clock.advance(5000);
    expect(client.transport.closed?.code).toBe(4408);
  });
});
