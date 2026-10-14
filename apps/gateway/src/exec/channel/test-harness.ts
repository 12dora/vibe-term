import type { Device } from '@vibeterm/shared';
import {
  type EcFrame,
  EcKind,
  FrameDecoder,
  decodeJson,
  encodeFrame,
  encodeJsonFrame,
} from '@vibeterm/shared/exec-channel';
import { attachExecChannelWith } from './connection';
import type { ExecChannelDeps, ExecClock } from './deps';
import type { ExecProcess, ExecProcessExit } from './process';
import type { ExecChannelAuth, ExecTransport } from './transport-types';

export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

export class FakeClock implements ExecClock {
  private time = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].fn();
      await flush();
    }
    this.time = target;
    await flush();
  }
}

export class FakeTransport implements ExecTransport {
  readonly frames: EcFrame[] = [];
  buffered = 0;
  closed: { code: number; reason: string } | null = null;
  private readonly decoder = new FrameDecoder();
  private readonly drainCbs: Array<() => void> = [];

  get bufferedBytes(): number {
    return this.buffered;
  }

  send(frame: Uint8Array): void {
    this.frames.push(...this.decoder.push(frame));
  }

  onDrain(cb: () => void): void {
    this.drainCbs.push(cb);
  }

  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }

  drain(): void {
    this.buffered = 0;
    for (const cb of this.drainCbs) cb();
  }

  ofKind(kind: number): EcFrame[] {
    return this.frames.filter((frame) => frame.kind === kind);
  }

  json<T>(kind: number): T[] {
    return this.ofKind(kind).map((frame) => decodeJson<T>(frame.payload));
  }

  loggedBytes(): number {
    return this.frames
      .filter((f) => f.kind === EcKind.STDOUT || f.kind === EcKind.STDERR || f.kind === EcKind.EXIT)
      .reduce((sum, f) => sum + 5 + f.payload.byteLength, 0);
  }

  concat(kind: number): Uint8Array {
    return concatBytes(this.ofKind(kind).map((frame) => frame.payload));
  }
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  return out;
}

class Pipe {
  private queue: Array<Uint8Array | null> = [];
  private waiters: Array<(v: Uint8Array | null) => void> = [];

  push(value: Uint8Array | null): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.queue.push(value);
  }

  next(): Promise<Uint8Array | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift() as Uint8Array | null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export class FakeProcess implements ExecProcess {
  pid: number | null = 4242;
  pty = false;
  stdoutReads = 0;
  infiniteStdout = false;
  stdinWrites: Uint8Array[] = [];
  stdinEnded = false;
  writeGate: Promise<void> | null = null;
  resizes: Array<[number, number]> = [];
  signals: string[] = [];
  killCount = 0;
  readonly exited: Promise<ExecProcessExit>;
  private resolveExit!: (status: ExecProcessExit) => void;
  private readonly out = new Pipe();
  private readonly err = new Pipe();

  constructor() {
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  readStdout(): Promise<Uint8Array | null> {
    this.stdoutReads += 1;
    if (this.infiniteStdout) return Promise.resolve(new Uint8Array(64 * 1024).fill(7));
    return this.out.next();
  }

  readStderr(): Promise<Uint8Array | null> {
    return this.err.next();
  }

  async writeStdin(bytes: Uint8Array): Promise<void> {
    await this.writeGate;
    this.stdinWrites.push(bytes);
  }

  async endStdin(): Promise<void> {
    this.stdinEnded = true;
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  signal(sig: string): void {
    this.signals.push(sig);
  }

  kill(): void {
    this.killCount += 1;
    this.finish(null, 'SIGTERM');
  }

  stdout(text: string | Uint8Array): void {
    this.out.push(typeof text === 'string' ? new TextEncoder().encode(text) : text);
  }

  stderr(text: string): void {
    this.err.push(new TextEncoder().encode(text));
  }

  finish(code: number | null = 0, signal: string | null = null): void {
    this.infiniteStdout = false;
    this.out.push(null);
    this.err.push(null);
    this.resolveExit({ code, signal });
  }
}

export const LOCAL_DEVICE: Device = {
  id: 'dev-local',
  name: 'Local',
  type: 'local',
  authMode: 'auto',
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

export type TestEnv = {
  clock: FakeClock;
  procs: FakeProcess[];
  deps: ExecChannelDeps;
  nextSpawn: { proc: FakeProcess | null; error: Error | null };
};

export function makeEnv(maxSessions = 64): TestEnv {
  const clock = new FakeClock();
  const procs: FakeProcess[] = [];
  const nextSpawn: TestEnv['nextSpawn'] = { proc: null, error: null };
  const deps: ExecChannelDeps = {
    clock,
    maxSessions,
    resolveDevice: (ref) => (ref === 'missing' ? null : LOCAL_DEVICE),
    spawn: async () => {
      if (nextSpawn.error) throw nextSpawn.error;
      const proc = nextSpawn.proc ?? new FakeProcess();
      nextSpawn.proc = null;
      procs.push(proc);
      return proc;
    },
  };
  return { clock, procs, deps, nextSpawn };
}

export function connect(env: TestEnv, auth: ExecChannelAuth = { uid: 'u1', tokenId: null }) {
  const transport = new FakeTransport();
  const inbound = attachExecChannelWith(transport, auth, env.deps);
  const send = (kind: number, body?: unknown) =>
    inbound.onBytes(
      body === undefined ? encodeFrame(kind, new Uint8Array(0)) : encodeJsonFrame(kind, body)
    );
  return { transport, inbound, send };
}

export function openSpec(extra: Record<string, unknown> = {}) {
  return { command: { kind: 'shell', script: 'true' }, stdin: true, ...extra };
}

export type Client = ReturnType<typeof connect>;

export async function openSession(
  env: TestEnv,
  spec: Record<string, unknown> = {},
  auth?: ExecChannelAuth
): Promise<{ client: Client; proc: FakeProcess; sessionId: string }> {
  const client = connect(env, auth);
  client.send(EcKind.HELLO, { v: 1, op: 'open', spec: openSpec(spec) });
  await flush();
  const ready = client.transport.json<{ sessionId: string }>(EcKind.READY)[0];
  if (!ready) throw new Error('no READY');
  return {
    client,
    proc: env.procs[env.procs.length - 1] as FakeProcess,
    sessionId: ready.sessionId,
  };
}

export function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function text(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}
