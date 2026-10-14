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
import { CliError, NetworkError, errorText } from './errors';
import {
  type ConnEnd,
  type ConnHandlers,
  DEFAULT_TIMING,
  type ExecChannelTiming,
  ExecConnection,
} from './exec-channel-conn';
import { errorFromFrame } from './exec-channel-errors';
import { OutputSink, StdinPump } from './exec-channel-io';
import {
  type ForwardedSignal,
  enterRawMode,
  installSignalHandlers,
  signalNumber,
  ttySize,
  watchResize,
} from './exec-channel-pty';
import type { ExecChannelIo, ExecChannelOptions, ExecChannelResult } from './exec-channel-result';
import { ReconnectBudget, assertRetryable } from './exec-channel-retry';
import {
  type ExecSocketConnect,
  connectWsExecSocket,
  execSocketTarget,
} from './exec-channel-socket';

export { ExecChannelUnsupportedError } from './exec-channel-errors';
export { exitCodeOf } from './exec-channel-result';
export type { ExecChannelIo, ExecChannelOptions, ExecChannelResult } from './exec-channel-result';
export type { ExecChannelTiming } from './exec-channel-conn';

const FALLBACK_SIGNO = 2;

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
  private interrupt: ForwardedSignal | null = null;
  private signalCount = 0;
  private readonly budget: ReconnectBudget;
  private wake: (() => void) | null = null;

  constructor(
    private readonly ctx: CliContext,
    private readonly nodeId: string,
    private readonly spec: ExecOpenSpec,
    private readonly io: ExecChannelIo,
    private readonly opts: ExecChannelOptions
  ) {
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.connect = opts.connect ?? connectWsExecSocket;
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
    this.conn?.abort();
    this.sink.dispose();
    this.stdin?.stop();
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
  }

  private async loop(): Promise<ExecChannelResult> {
    for (;;) {
      const end = await this.attempt();
      if (this.interrupt) return this.interruptedResult(this.interrupt);
      if (end.kind === 'done' && this.result) return this.result;
      if (end.kind === 'fatal') throw end.error;
      if (end.kind !== 'lost') throw new NetworkError('exec channel closed unexpectedly');
      assertRetryable(this.nodeId, end, this.ready !== null);
      await this.backoff();
    }
  }

  private async attempt(): Promise<ConnEnd> {
    if (this.interrupt) return { kind: 'aborted' };
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
    await this.sleep(delay);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      this.wake = null;
    });
  }

  private onReady(ready: ExecReady): void {
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
      throw error;
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
    this.signalCount += 1;
    if (this.ready && this.signalCount === 1) {
      if (!this.sendLiveJson(EcKind.SIGNAL, { signal })) this.pendingSignals.push(signal);
      return;
    }
    this.interrupt = signal;
    if (this.ready) {
      this.conn?.sendJson(EcKind.CLOSE, { kill: true });
      this.conn?.finish(true);
    } else {
      this.conn?.abort();
    }
    this.wake?.();
  }

  private interruptedResult(signal: ForwardedSignal): ExecChannelResult {
    if (!this.ready) {
      throw new CliError('interrupted', 128 + (signalNumber(signal) ?? FALLBACK_SIGNO));
    }
    return {
      exitCode: null,
      signal,
      reason: 'killed',
      durationMs: Date.now() - this.startedAt,
      device: this.ready.device,
    };
  }
}
