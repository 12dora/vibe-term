// exec 通道（EC1）客户端：一条可断线续传的 WebSocket 字节管道，行为对齐 `ssh host cmd`。
// 本文件是会话层：开会话、输出有序落盘 + ACK、stdin 流控、信号 / PTY、断线重连与 resume。
// 帧传输见 exec-channel-conn.ts，错误翻译见 exec-channel-errors.ts。

import { Readable } from 'node:stream';
import {
  EC_DEFAULT_DETACH_GRACE_MS,
  type EcFrame,
  EcKind,
  type ExecErrorPayload,
  type ExecExit,
  type ExecHello,
  type ExecOpenSpec,
  type ExecReady,
  type ExecSignal,
  decodeJson,
} from '@vibeterm/shared/exec-channel';
import type { CliContext } from './context';
import { NetworkError, errorText } from './errors';
import {
  type ConnEnd,
  type ConnHandlers,
  DEFAULT_TIMING,
  type ExecChannelTiming,
  ExecConnection,
} from './exec-channel-conn';
import { LocalOutputClosedError, errorFromFrame, isBrokenPipe } from './exec-channel-errors';
import { InterruptState, interruptedResult } from './exec-channel-interrupt';
import { OutputSink, StdinPump } from './exec-channel-io';
import {
  type ForwardedSignal,
  enterRawMode,
  installSignalHandlers,
  ttySize,
  watchResize,
} from './exec-channel-pty';
import type { ExecChannelIo, ExecChannelOptions, ExecChannelResult } from './exec-channel-result';
import { ReconnectBudget, Sleeper, assertRetryable } from './exec-channel-retry';
import {
  type ExecSocketConnect,
  connectWsExecSocket,
  execSocketTarget,
} from './exec-channel-socket';

export { ExecChannelUnsupportedError, LocalOutputClosedError } from './exec-channel-errors';
export { exitCodeOf } from './exec-channel-result';
export type { ExecChannelIo, ExecChannelOptions, ExecChannelResult } from './exec-channel-result';
export type { ExecChannelTiming } from './exec-channel-conn';

const RESUME_KILL_MS = 3000;
const READY_KILL_MS = 1500;
const KILL_RETRY_MS = 100;

export async function runExecChannel(
  ctx: CliContext,
  nodeId: string,
  spec: ExecOpenSpec,
  io: ExecChannelIo,
  opts: ExecChannelOptions = {}
): Promise<ExecChannelResult> {
  return new ExecChannelRun(ctx, nodeId, spec, io, opts).run();
}

class ExecChannelRun {
  private readonly timing: ExecChannelTiming;
  private readonly connect: ExecSocketConnect;
  private readonly sink: OutputSink;
  private readonly startedAt = Date.now();
  private readonly cleanups: Array<() => void> = [];
  private readonly pendingSignals: ExecSignal[] = [];
  private conn: ExecConnection | null = null;
  private ready: ExecReady | null = null;
  private stdin: StdinPump | null = null;
  private result: ExecChannelResult | null = null;
  private readonly intr: InterruptState;
  private readonly budget: ReconnectBudget;
  private readonly sleeper = new Sleeper();

  constructor(
    private readonly ctx: CliContext,
    private readonly nodeId: string,
    private readonly spec: ExecOpenSpec,
    private readonly io: ExecChannelIo,
    private readonly opts: ExecChannelOptions
  ) {
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.connect = opts.connect ?? connectWsExecSocket;
    this.intr = new InterruptState(Boolean(spec.pty));
    this.budget = new ReconnectBudget(
      spec.detachGraceMs ?? EC_DEFAULT_DETACH_GRACE_MS,
      this.timing.backoffMs
    );
    this.sink = new OutputSink(
      io.stdout,
      io.stderr,
      (out) => this.sendLiveJson(EcKind.ACK, { out }),
      this.timing.ackDelayMs
    );
  }

  async run(): Promise<ExecChannelResult> {
    this.cleanups.push(installSignalHandlers((signal) => this.onSignal(signal)));
    try {
      return await this.loop();
    } finally {
      this.dispose();
    }
  }

  private dispose(): void {
    this.intr.disarm();
    this.conn?.abort();
    this.sink.dispose();
    this.stdin?.stop();
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
  }

  private async loop(): Promise<ExecChannelResult> {
    for (;;) {
      const end = await this.attempt();
      const signal = this.intr.signal;
      if (signal && this.intr.shouldStop(end.kind, this.ready !== null)) {
        return interruptedResult(signal, this.ready, this.startedAt);
      }
      if (end.kind === 'done' && this.result) return this.result;
      if (end.kind === 'fatal') throw end.error;
      if (end.kind !== 'lost') throw new NetworkError('exec channel closed unexpectedly');
      if (this.intr.killPending) {
        await this.sleeper.sleep(KILL_RETRY_MS);
        continue;
      }
      assertRetryable(this.ctx.http.entry, this.nodeId, end, this.ready !== null);
      await this.backoff();
    }
  }

  private async attempt(): Promise<ConnEnd> {
    if (this.intr.signal && !this.intr.killPending) return { kind: 'aborted' };
    let conn: ExecConnection;
    try {
      const socket = this.connect(execSocketTarget(this.ctx, this.nodeId));
      conn = new ExecConnection(socket, this.hello(), this.handlers(), this.timing);
    } catch (error) {
      const message = `cannot open exec channel: ${errorText(error)}`;
      return { kind: 'fatal', error: new NetworkError(message) };
    }
    this.conn = conn;
    return conn.settled;
  }

  private hello(): ExecHello {
    if (!this.ready) return { v: 1, op: 'open', spec: this.spec };
    return { v: 1, op: 'resume', sessionId: this.ready.sessionId, out: this.sink.offset };
  }

  private handlers(): ConnHandlers {
    return {
      ready: (ready) => this.onReady(ready),
      stdinAck: (stdin) => this.stdin?.ack(stdin),
      frame: (frame) => this.onFrame(frame),
    };
  }

  private async backoff(): Promise<void> {
    const delay = this.budget.nextDelay();
    if (this.opts.verbose) {
      this.ctx.out.warn(`connection lost, reconnecting (attempt ${this.budget.attempt})`);
    }
    await this.sleeper.sleep(delay);
  }

  private onReady(ready: ExecReady): void {
    if (this.intr.killPending) {
      this.killOnReady(ready);
      return;
    }
    const resuming = this.ready !== null;
    if (resuming && (!ready.resumed || ready.out !== this.sink.offset)) {
      throw new NetworkError('exec channel resume was rejected by the node');
    }
    this.budget.reset();
    if (resuming) this.resume(ready);
    else this.start(ready);
    for (const signal of this.pendingSignals.splice(0)) {
      this.sendLiveJson(EcKind.SIGNAL, { signal });
    }
  }

  private start(ready: ExecReady): void {
    this.ready = ready;
    this.opts.onReady?.(ready);
    const tty = this.spec.pty ? this.io.tty : null;
    if (tty) {
      this.cleanups.push(enterRawMode(tty.input));
      this.cleanups.push(watchResize(tty.output, () => this.sendResize()));
    }
    if (!this.spec.stdin) return;
    const source = tty ? tty.input : (this.io.stdin ?? Readable.from([]));
    this.stdin = new StdinPump(
      source,
      (kind, payload) => this.conn?.sendIfLive(kind, payload) ?? false
    );
    this.stdin.start(ready.window.stdin);
  }

  private resume(ready: ExecReady): void {
    if (this.stdin && !this.stdin.resend(ready.stdin, ready.stdinClosed)) {
      throw new NetworkError('cannot resume stdin: the node reported an unexpected offset');
    }
    this.sink.flush(true);
    if (this.spec.pty && this.io.tty) this.sendResize();
  }

  private sendLiveJson(kind: number, body: unknown): boolean {
    return this.conn?.live ? this.conn.sendJson(kind, body) : false;
  }

  private sendResize(): void {
    const tty = this.io.tty;
    if (!tty || !this.spec.pty) return;
    this.sendLiveJson(EcKind.RESIZE, ttySize(tty.output, this.spec.pty));
  }

  private async onFrame(frame: EcFrame): Promise<void> {
    if (frame.kind === EcKind.EXIT) return this.onExit(frame);
    if (frame.kind === EcKind.ERROR) {
      throw errorFromFrame(decodeJson<ExecErrorPayload>(frame.payload));
    }
    try {
      await this.sink.write(frame.kind, frame.payload);
    } catch (error) {
      this.conn?.sendJson(EcKind.CLOSE, { kill: true });
      throw isBrokenPipe(error) ? new LocalOutputClosedError() : error;
    }
  }

  private onExit(frame: EcFrame): void {
    const exit = decodeJson<ExecExit>(frame.payload);
    this.sink.count(frame.payload.byteLength);
    this.result = {
      exitCode: exit.code,
      signal: exit.signal,
      reason: exit.reason,
      durationMs: exit.durationMs,
      device: (this.ready as ExecReady).device,
    };
    this.sink.flush();
    this.conn?.sendJson(EcKind.CLOSE, { kill: false });
    this.conn?.finish();
  }

  private onSignal(signal: ForwardedSignal): void {
    const action = this.intr.press(signal, this.ready !== null);
    if (action === 'kill') {
      this.beginKill();
      return;
    }
    if (!this.sendLiveJson(EcKind.SIGNAL, { signal })) this.pendingSignals.push(signal);
    if (action === 'graceful') {
      this.intr.armGrace(signal, this.timing.termGraceMs, () => this.beginKill());
    }
  }

  /** 结束会话：链路通则立即 CLOSE{kill:true}；链路不通则限时重连 / 等 READY 后投递。 */
  private beginKill(): void {
    if (this.intr.killPending) {
      this.giveUpKill();
      return;
    }
    const conn = this.conn;
    if (conn?.live) {
      this.sendKill(conn);
    } else if (this.ready || conn?.isOpen) {
      this.intr.arm(this.ready ? RESUME_KILL_MS : READY_KILL_MS, () => this.giveUpKill());
    } else {
      conn?.abort();
    }
    this.sleeper.wake();
  }

  private killOnReady(ready: ExecReady): void {
    this.ready ??= ready;
    if (this.conn) this.sendKill(this.conn);
  }

  private sendKill(conn: ExecConnection): void {
    conn.sendJson(EcKind.CLOSE, { kill: true });
    conn.finish(true);
  }

  private giveUpKill(): void {
    this.intr.disarm();
    this.conn?.abort();
    this.sleeper.wake();
  }
}
