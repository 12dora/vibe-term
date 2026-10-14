import type { Device } from '@vibeterm/shared';
import {
  EC_CHUNK_BYTES,
  EC_MAX_PTY_DIMENSION,
  EC_SIGNALS,
  EC_WINDOW_BYTES,
  EcKind,
  type ExecExit,
  type ExecReady,
  type ExecSignal,
  OutputLog,
  type ResolvedExecOpenSpec,
  encodeFrame,
  encodeJsonFrame,
} from '@vibeterm/shared/exec-channel';
import type { ExecClock } from './deps';
import type { ExecProcess } from './process';
import { removeSession } from './registry';
import { StdinPump } from './session-stdin';
import type { ExecTransport } from './transport-types';

const TRANSPORT_BUFFER_LIMIT = 1024 * 1024;

export class ProtocolViolation extends Error {}

export interface ExecSessionInit {
  id: string;
  uid: string | null;
  tokenId: string | null;
  device: Device;
  spec: ResolvedExecOpenSpec;
  proc: ExecProcess;
}

type Attachment = { transport: ExecTransport; queue: Uint8Array[]; head: number };
type ReadFn = () => Promise<Uint8Array | null>;

export class ExecSession {
  readonly id: string;
  readonly uid: string | null;
  readonly tokenId: string | null;
  private readonly log = new OutputLog();
  private readonly stdin: StdinPump;
  private readonly startedAt: number;
  private readonly spec: ResolvedExecOpenSpec;
  private readonly device: Device;
  private readonly proc: ExecProcess;
  private att: Attachment | null = null;
  private waiters: Array<() => void> = [];
  private graceTimer: unknown = null;
  private timeoutTimer: unknown = null;
  private exitLogged = false;
  private timedOut = false;
  private disposed = false;

  constructor(
    init: ExecSessionInit,
    private readonly clock: ExecClock
  ) {
    this.id = init.id;
    this.uid = init.uid;
    this.tokenId = init.tokenId;
    this.spec = init.spec;
    this.device = init.device;
    this.proc = init.proc;
    this.startedAt = clock.now();
    this.stdin = new StdinPump(init.proc, (written) =>
      this.sendControl(EcKind.STDIN_ACK, { stdin: written })
    );
  }

  start(): void {
    if (this.spec.timeoutMs > 0) {
      this.timeoutTimer = this.clock.setTimeout(() => this.onTimeout(), this.spec.timeoutMs);
    }
    void this.run();
  }

  ready(resumed: boolean, out: number): ExecReady {
    return {
      sessionId: this.id,
      resumed,
      pid: this.proc.pid,
      device: { id: this.device.id, name: this.device.name, type: this.device.type },
      pty: this.proc.pty,
      stdin: this.stdin.received,
      stdinClosed: this.stdin.eof,
      out,
      window: { stdin: EC_WINDOW_BYTES, out: EC_WINDOW_BYTES },
    };
  }

  resumeFrames(out: number): Uint8Array[] | null {
    return this.log.sliceFrom(out);
  }

  attach(transport: ExecTransport, backlog: Uint8Array[]): void {
    const previous = this.att;
    this.att = { transport, queue: backlog, head: 0 };
    this.clearGrace();
    previous?.transport.close(4409, 'taken over');
    this.pump();
  }

  detach(transport: ExecTransport): void {
    if (this.disposed || this.att?.transport !== transport) return;
    this.att = null;
    this.startGrace();
    this.wake();
  }

  pump(): void {
    this.flush();
    this.wake();
  }

  onStdin(bytes: Uint8Array): void {
    if (!this.spec.stdin) throw new ProtocolViolation('stdin is disabled for this session');
    if (this.stdin.eof) throw new ProtocolViolation('STDIN after STDIN_EOF');
    this.stdin.push(bytes);
  }

  onStdinEof(): void {
    if (this.spec.stdin) this.stdin.end();
  }

  onResize(cols: number, rows: number): void {
    const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= EC_MAX_PTY_DIMENSION;
    if (!valid(cols) || !valid(rows)) throw new ProtocolViolation('invalid terminal size');
    if (!this.exitLogged) this.proc.resize(cols, rows);
  }

  onSignal(signal: string): void {
    if (!(EC_SIGNALS as readonly string[]).includes(signal)) {
      throw new ProtocolViolation('unsupported signal');
    }
    if (!this.exitLogged) this.proc.signal(signal as ExecSignal);
  }

  onAck(out: number): void {
    if (!this.log.ack(out)) throw new ProtocolViolation('invalid ack offset');
    this.wake();
    if (this.exitLogged && this.log.unacked === 0) this.dispose(1000, 'done');
  }

  onClose(kill: boolean): void {
    if (this.exitLogged || kill) {
      if (!this.exitLogged) this.proc.kill();
      this.dispose(1000, 'closed');
      return;
    }
    const transport = this.att?.transport;
    this.att = null;
    this.startGrace();
    this.wake();
    transport?.close(1000, 'closed');
  }

  terminate(code: number, reason: string): void {
    if (!this.exitLogged) this.proc.kill();
    this.dispose(code, reason);
  }

  private sendControl(kind: number, obj: unknown): void {
    this.att?.transport.send(encodeJsonFrame(kind, obj));
  }

  private logFrame(frame: Uint8Array): void {
    this.log.append(frame);
    this.att?.queue.push(frame);
    this.flush();
  }

  private flush(): void {
    const att = this.att;
    if (!att) return;
    while (att.head < att.queue.length && att.transport.bufferedBytes < TRANSPORT_BUFFER_LIMIT) {
      att.transport.send(att.queue[att.head++] as Uint8Array);
    }
    if (att.head === att.queue.length) {
      att.queue = [];
      att.head = 0;
    } else if (att.head > 1024) {
      att.queue = att.queue.slice(att.head);
      att.head = 0;
    }
  }

  private canRead(): boolean {
    if (this.log.unacked >= EC_WINDOW_BYTES) return false;
    return !this.att || this.att.transport.bufferedBytes < TRANSPORT_BUFFER_LIMIT;
  }

  private async untilReadable(): Promise<void> {
    while (!this.disposed && !this.canRead()) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  private emit(kind: number, chunk: Uint8Array): void {
    for (let at = 0; at < chunk.byteLength; at += EC_CHUNK_BYTES) {
      this.logFrame(encodeFrame(kind, chunk.subarray(at, at + EC_CHUNK_BYTES)));
    }
  }

  private async pumpStream(read: ReadFn, kind: number): Promise<void> {
    for (;;) {
      await this.untilReadable();
      if (this.disposed) return;
      const chunk = await read().catch(() => null);
      if (chunk === null || this.disposed) return;
      this.emit(kind, chunk);
    }
  }

  private async run(): Promise<void> {
    await Promise.all([
      this.pumpStream(() => this.proc.readStdout(), EcKind.STDOUT),
      this.pumpStream(() => this.proc.readStderr(), EcKind.STDERR),
    ]);
    const status = await this.proc.exited.catch(() => ({ code: null, signal: null }));
    if (this.disposed) return;
    this.clearTimeoutTimer();
    const exit: ExecExit = {
      code: status.code,
      signal: status.signal,
      reason: this.timedOut ? 'timeout' : 'exit',
      durationMs: this.clock.now() - this.startedAt,
    };
    this.exitLogged = true;
    this.logFrame(encodeJsonFrame(EcKind.EXIT, exit));
  }

  private onTimeout(): void {
    this.timeoutTimer = null;
    this.timedOut = true;
    this.proc.kill();
  }

  private startGrace(): void {
    this.clearGrace();
    this.graceTimer = this.clock.setTimeout(() => this.onGraceExpired(), this.spec.detachGraceMs);
  }

  private onGraceExpired(): void {
    this.graceTimer = null;
    if (!this.exitLogged) {
      this.proc.signal('SIGHUP');
      this.proc.kill();
    }
    this.dispose(1000, 'grace expired');
  }

  private clearGrace(): void {
    if (this.graceTimer !== null) this.clock.clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private clearTimeoutTimer(): void {
    if (this.timeoutTimer !== null) this.clock.clearTimeout(this.timeoutTimer);
    this.timeoutTimer = null;
  }

  private dispose(code: number, reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearGrace();
    this.clearTimeoutTimer();
    this.stdin.stop();
    removeSession(this.id);
    const transport = this.att?.transport;
    this.att = null;
    this.wake();
    transport?.close(code, reason);
  }
}
