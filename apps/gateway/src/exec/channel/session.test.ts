import { afterEach, describe, expect, test } from 'bun:test';
import {
  EC_WINDOW_BYTES,
  EcKind,
  type ExecExit,
  type ExecReady,
  encodeFrame,
} from '@vibeterm/shared/exec-channel';
import { ExecChannelError } from './errors';
import { liveSessionCount, resetExecRegistryForTests } from './registry';
import {
  FakeProcess,
  LOCAL_DEVICE,
  bytes,
  connect,
  flush,
  makeEnv,
  openSession,
  text,
} from './test-harness';

afterEach(() => resetExecRegistryForTests());

const errorOf = (t: { json<T>(kind: number): T[] }) =>
  t.json<{ code: string; message: string }>(EcKind.ERROR)[0];

describe('open / ready / output / exit', () => {
  test('lifecycle: READY, ordered output, EXIT, ACK disposes', async () => {
    const env = makeEnv();
    const { client, proc, sessionId } = await openSession(env);
    const ready = client.transport.json<ExecReady>(EcKind.READY)[0] as ExecReady;
    expect(sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(ready).toMatchObject({
      resumed: false,
      pid: 4242,
      device: { id: 'dev-local', name: 'Local', type: 'local' },
      pty: false,
      stdin: 0,
      stdinClosed: false,
      out: 0,
      window: { stdin: EC_WINDOW_BYTES, out: EC_WINDOW_BYTES },
    });
    proc.stdout('hello');
    proc.stderr('oops');
    proc.finish(3);
    await flush();
    const kinds = client.transport.frames.map((f) => f.kind);
    expect(kinds[0]).toBe(EcKind.READY);
    expect(kinds[kinds.length - 1]).toBe(EcKind.EXIT);
    expect(text(client.transport.concat(EcKind.STDOUT))).toBe('hello');
    expect(text(client.transport.concat(EcKind.STDERR))).toBe('oops');
    const exit = client.transport.json<ExecExit>(EcKind.EXIT)[0] as ExecExit;
    expect(exit).toMatchObject({ code: 3, signal: null, reason: 'exit' });
    expect(liveSessionCount()).toBe(1);
    client.send(EcKind.ACK, { out: client.transport.loggedBytes() });
    expect(liveSessionCount()).toBe(0);
    expect(client.transport.closed?.code).toBe(1000);
  });

  test('splits large chunks into frames of at most 64 KiB', async () => {
    const env = makeEnv();
    const { client, proc } = await openSession(env);
    const payload = new Uint8Array(150_000).map((_, i) => i % 251);
    proc.stdout(payload);
    await flush();
    const frames = client.transport.ofKind(EcKind.STDOUT);
    expect(frames.map((f) => f.payload.byteLength)).toEqual([65536, 65536, 18928]);
    expect(client.transport.concat(EcKind.STDOUT)).toEqual(payload);
  });
});

describe('open failures', () => {
  test('device_not_found', async () => {
    const env = makeEnv();
    const client = connect(env);
    client.send(EcKind.HELLO, {
      v: 1,
      op: 'open',
      spec: { command: { kind: 'shell', script: 'x' }, stdin: true, device: 'missing' },
    });
    await flush();
    expect(errorOf(client.transport)?.code).toBe('device_not_found');
    expect(client.transport.closed?.code).toBe(4400);
    expect(liveSessionCount()).toBe(0);
  });

  test('unsupported device type', async () => {
    const env = makeEnv();
    env.deps.resolveDevice = () => ({ ...LOCAL_DEVICE, type: 'weird' as never });
    const client = connect(env);
    client.send(EcKind.HELLO, {
      v: 1,
      op: 'open',
      spec: { command: { kind: 'login' }, stdin: true },
    });
    await flush();
    expect(errorOf(client.transport)?.code).toBe('exec_unsupported_device');
  });

  test('spawn errors keep their code, unknown ones become exec_spawn_failed', async () => {
    const env = makeEnv();
    env.nextSpawn.error = new ExecChannelError('pty_unsupported', 'no pty');
    const a = connect(env);
    a.send(EcKind.HELLO, { v: 1, op: 'open', spec: { command: { kind: 'login' }, stdin: true } });
    await flush();
    expect(errorOf(a.transport)).toEqual({ code: 'pty_unsupported', message: 'no pty' });
    env.nextSpawn.error = new Error('boom');
    const b = connect(env);
    b.send(EcKind.HELLO, { v: 1, op: 'open', spec: { command: { kind: 'login' }, stdin: true } });
    await flush();
    expect(errorOf(b.transport)?.code).toBe('exec_spawn_failed');
    expect(liveSessionCount()).toBe(0);
  });

  test('session_limit counts live sessions', async () => {
    const env = makeEnv(1);
    await openSession(env);
    const second = connect(env);
    second.send(EcKind.HELLO, {
      v: 1,
      op: 'open',
      spec: { command: { kind: 'login' }, stdin: true },
    });
    await flush();
    expect(errorOf(second.transport)?.code).toBe('session_limit');
  });

  test('invalid spec yields invalid_request', async () => {
    const env = makeEnv();
    const client = connect(env);
    client.send(EcKind.HELLO, {
      v: 1,
      op: 'open',
      spec: { command: { kind: 'bogus' }, stdin: true },
    });
    await flush();
    expect(errorOf(client.transport)?.code).toBe('invalid_request');
    expect(client.transport.closed?.code).toBe(4400);
  });
});

describe('protocol errors', () => {
  test('first frame must be HELLO', () => {
    const client = connect(makeEnv());
    client.send(EcKind.PING);
    expect(errorOf(client.transport)?.code).toBe('protocol_error');
    expect(client.transport.closed?.code).toBe(4400);
  });

  test('garbage bytes never throw out of onBytes', () => {
    const client = connect(makeEnv());
    expect(() => client.inbound.onBytes(new Uint8Array([0xff, 0, 0, 0, 0]))).not.toThrow();
    expect(errorOf(client.transport)?.code).toBe('protocol_error');
  });

  test('STDIN before READY is rejected and the pending spawn is reaped', async () => {
    const env = makeEnv();
    const client = connect(env);
    client.send(EcKind.HELLO, {
      v: 1,
      op: 'open',
      spec: { command: { kind: 'login' }, stdin: true },
    });
    client.inbound.onBytes(encodeFrame(EcKind.STDIN, bytes('x')));
    expect(errorOf(client.transport)?.code).toBe('protocol_error');
    await flush();
    expect((env.procs[0] as FakeProcess).killCount).toBe(1);
    expect(liveSessionCount()).toBe(0);
  });

  test('STDIN with stdin=false is rejected', async () => {
    const { client } = await openSession(makeEnv(), { stdin: false });
    client.inbound.onBytes(encodeFrame(EcKind.STDIN, bytes('x')));
    expect(errorOf(client.transport)?.code).toBe('protocol_error');
  });

  test('bad signal, bad resize and out-of-range ACK are protocol errors', async () => {
    const env = makeEnv();
    for (const [kind, body] of [
      [EcKind.SIGNAL, { signal: 'SIGFOO' }],
      [EcKind.RESIZE, { cols: 0, rows: 10 }],
      [EcKind.ACK, { out: 999 }],
      [EcKind.ACK, { out: 'x' }],
    ] as const) {
      const { client } = await openSession(env);
      client.send(kind, body);
      expect(errorOf(client.transport)?.code).toBe('protocol_error');
      expect(client.transport.closed?.code).toBe(4400);
    }
  });

  test('SIGNAL and RESIZE reach the process', async () => {
    const { client, proc } = await openSession(makeEnv());
    client.send(EcKind.SIGNAL, { signal: 'SIGINT' });
    client.send(EcKind.RESIZE, { cols: 100, rows: 30 });
    expect(proc.signals).toEqual(['SIGINT']);
    expect(proc.resizes).toEqual([[100, 30]]);
  });
});

describe('flow control', () => {
  test('stops reading at the 4 MiB output window and resumes on ACK', async () => {
    const env = makeEnv();
    const proc = new FakeProcess();
    proc.infiniteStdout = true;
    env.nextSpawn.proc = proc;
    const { client } = await openSession(env);
    await flush();
    const first = client.transport.loggedBytes();
    expect(first).toBeGreaterThanOrEqual(EC_WINDOW_BYTES);
    expect(first).toBeLessThan(EC_WINDOW_BYTES + 65541);
    const reads = proc.stdoutReads;
    await flush();
    expect(proc.stdoutReads).toBe(reads);
    client.send(EcKind.ACK, { out: first });
    await flush();
    expect(client.transport.loggedBytes()).toBeGreaterThan(first);
    client.send(EcKind.CLOSE, { kill: true });
  });

  test('stops reading while the transport buffer is above 1 MiB, resumes on drain', async () => {
    const { client, proc } = await openSession(makeEnv());
    client.transport.buffered = 2 * 1024 * 1024;
    proc.stdout('a');
    await flush();
    proc.stdout('b');
    await flush();
    expect(proc.stdoutReads).toBe(1);
    expect(client.transport.ofKind(EcKind.STDOUT)).toHaveLength(0);
    client.transport.drain();
    await flush();
    expect(text(client.transport.concat(EcKind.STDOUT))).toBe('ab');
  });
});
