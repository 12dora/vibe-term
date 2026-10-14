// exec 通道单测共用：进程内假 EC1 服务端（不走网络）。只被 *.test.ts import，不进 bundle。

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import {
  EC_WINDOW_BYTES,
  type EcFrame,
  EcKind,
  type ExecHello,
  type ExecOpenSpec,
  type ExecReady,
  FrameDecoder,
  decodeJson,
  encodeFrame,
  encodeJsonFrame,
} from '@vibeterm/shared/exec-channel';
import { type CliContext, buildContext } from './context';
import type { ExecChannelIo } from './exec-channel-result';
import type { ExecSocketConnect, ExecSocketLike, ExecSocketTarget } from './exec-channel-socket';

export const DEVICE = { id: 'dev-1', name: 'box', type: 'local' } as const;
export const EMPTY = new Uint8Array(0);

export function readyOf(overrides: Partial<ExecReady> = {}): ExecReady {
  return {
    sessionId: 's'.repeat(32),
    resumed: false,
    pid: 1234,
    device: { ...DEVICE },
    pty: false,
    stdin: 0,
    stdinClosed: false,
    out: 0,
    window: { stdin: EC_WINDOW_BYTES, out: EC_WINDOW_BYTES },
    ...overrides,
  };
}

export class FakeSocket implements ExecSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((data: Uint8Array) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  toServer: ((data: Uint8Array) => void) | null = null;
  private closed = false;
  private dead = false;

  constructor() {
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data: Uint8Array): void {
    if (this.closed) throw new Error('socket closed');
    const copy = data.slice();
    setTimeout(() => {
      if (!this.dead) this.toServer?.(copy);
    }, 0);
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    setTimeout(() => this.onclose?.(code, reason), 0);
  }

  terminate(): void {
    if (this.dead) return;
    this.dead = true;
    this.close(1006, '');
  }

  deliver(data: Uint8Array): void {
    setTimeout(() => {
      if (!this.closed) this.onmessage?.(data);
    }, 0);
  }

  serverClose(code: number, reason: string): void {
    setTimeout(() => {
      if (this.closed) return;
      this.dead = true;
      this.closed = true;
      this.onclose?.(code, reason);
    }, 0);
  }
}

export class ServerConn {
  readonly frames: EcFrame[] = [];
  onFrame: ((frame: EcFrame) => void) | null = null;
  private readonly decoder = new FrameDecoder();

  constructor(
    readonly socket: FakeSocket,
    readonly index: number,
    readonly target: ExecSocketTarget
  ) {
    socket.toServer = (data) => {
      for (const frame of this.decoder.push(data)) {
        this.frames.push(frame);
        this.onFrame?.(frame);
      }
    };
  }

  send(kind: number, payload: Uint8Array = EMPTY): void {
    this.socket.deliver(encodeFrame(kind, payload));
  }

  sendJson(kind: number, body: unknown): void {
    this.socket.deliver(encodeJsonFrame(kind, body));
  }

  sendRaw(bytes: Uint8Array): void {
    this.socket.deliver(bytes);
  }

  drop(code = 1006, reason = ''): void {
    this.socket.serverClose(code, reason);
  }

  has(kind: number): boolean {
    return this.frames.some((frame) => frame.kind === kind);
  }

  json<T>(kind: number): T[] {
    return this.frames.filter((f) => f.kind === kind).map((f) => decodeJson<T>(f.payload));
  }

  hello(): ExecHello | undefined {
    return this.json<ExecHello>(EcKind.HELLO)[0];
  }

  bytes(kind: number): Uint8Array {
    return Buffer.concat(this.frames.filter((f) => f.kind === kind).map((f) => f.payload));
  }
}

export function fakeLink(onConn: (conn: ServerConn) => void) {
  const conns: ServerConn[] = [];
  const connect: ExecSocketConnect = (target) => {
    const conn = new ServerConn(new FakeSocket(), conns.length, target);
    conns.push(conn);
    onConn(conn);
    return conn.socket;
  };
  return { connect, conns };
}

export async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export function collectIo(overrides: Partial<ExecChannelIo> = {}) {
  const writes: Array<{ fd: 1 | 2; bytes: Uint8Array }> = [];
  const io: ExecChannelIo = {
    stdin: null,
    stdout: (bytes) => {
      writes.push({ fd: 1, bytes: bytes.slice() });
    },
    stderr: (bytes) => {
      writes.push({ fd: 2, bytes: bytes.slice() });
    },
    tty: null,
    ...overrides,
  };
  return { io, writes };
}

const dirs: string[] = [];

export async function cleanupContexts(): Promise<void> {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export async function testCtx(): Promise<{ ctx: CliContext; stderr: () => string }> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-ec-'));
  dirs.push(dir);
  const chunks: Buffer[] = [];
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const ctx = buildContext({
    entryFlag: 'http://entry.example:9883',
    node: null,
    json: false,
    quiet: false,
    noColor: true,
    configDir: dir,
    installEntry: null,
    env: {},
    fetchImpl: async () => new Response('{}'),
    stderr,
  });
  return { ctx, stderr: () => Buffer.concat(chunks).toString('utf8') };
}

export const SPEC: ExecOpenSpec = { command: { kind: 'shell', script: 'echo hi' }, stdin: false };
export const FAST = { ackDelayMs: 20, backoffMs: [5], pingMs: 10_000, deadMs: 60_000 };
export const EXIT_OK = { code: 0, signal: null, reason: 'exit', durationMs: 7 };

export function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function onHello(conn: ServerConn, handler: (hello: ExecHello) => void): void {
  conn.onFrame = (frame) => {
    if (frame.kind === EcKind.HELLO) handler(decodeJson<ExecHello>(frame.payload));
  };
}

export async function waitForConn(conns: ServerConn[]): Promise<ServerConn> {
  await waitFor(() => conns.length > 0);
  return conns[0] as ServerConn;
}
