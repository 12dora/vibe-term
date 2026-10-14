// 单条 exec 通道传输连接：HELLO、帧解码与分发、保活（PING/PONG/死链检测）。
// 日志类帧（STDOUT/STDERR/EXIT）与 ERROR 走串行队列保证写出顺序；控制帧同步处理，
// 这样本地输出被背压卡住时 PING/STDIN_ACK 仍然及时。

import {
  EC_ACK_DELAY_MS,
  EC_DEAD_MS,
  EC_PING_MS,
  type EcFrame,
  EcKind,
  type ExecHello,
  type ExecReady,
  FrameDecoder,
  decodeJson,
  encodeFrame,
  encodeJsonFrame,
} from '@vibeterm/shared/exec-channel';
import { CliError, NetworkError, errorText } from './errors';
import { OrderedQueue } from './exec-channel-io';
import type { ExecSocketLike } from './exec-channel-socket';

export interface ExecChannelTiming {
  pingMs: number;
  deadMs: number;
  ackDelayMs: number;
  /** 重连退避序列，用尽后沿用最后一项。 */
  backoffMs: readonly number[];
}

export const DEFAULT_TIMING: ExecChannelTiming = {
  pingMs: EC_PING_MS,
  deadMs: EC_DEAD_MS,
  ackDelayMs: EC_ACK_DELAY_MS,
  backoffMs: [500, 1000, 2000, 4000, 8000, 10_000],
};

export type ConnEnd =
  | { kind: 'done' }
  | { kind: 'aborted' }
  | { kind: 'fatal'; error: unknown }
  | { kind: 'lost'; code: number; reason: string; opened: boolean };

export interface ConnHandlers {
  ready(ready: ExecReady): void;
  stdinAck(stdin: number): void;
  /** STDOUT / STDERR / EXIT / ERROR，按到达顺序串行调用。 */
  frame(frame: EcFrame): Promise<void> | void;
}

const EMPTY = new Uint8Array(0);
const FINISH_GRACE_MS = 2000;

export class ExecConnection {
  readonly settled: Promise<ConnEnd>;
  live = false;
  private opened = false;
  private outcome: ConnEnd | null = null;
  private resolveSettled: (end: ConnEnd) => void = () => {};
  private readonly decoder = new FrameDecoder();
  private readonly queue = new OrderedQueue((error) => this.fail(error));
  private lastRecv = Date.now();
  private lastSend = Date.now();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly socket: ExecSocketLike,
    private readonly hello: ExecHello,
    private readonly handlers: ConnHandlers,
    private readonly timing: ExecChannelTiming
  ) {
    this.settled = new Promise((resolve) => {
      this.resolveSettled = resolve;
    });
    const shortest = Math.min(timing.pingMs, timing.deadMs);
    const tickMs = Math.max(5, Math.min(1000, Math.floor(shortest / 3)));
    this.timer = setInterval(() => this.tick(), tickMs);
    this.timer.unref?.();
    socket.onopen = () => this.handleOpen();
    socket.onmessage = (data) => this.handleMessage(data);
    socket.onclose = (code, reason) => this.handleClose(code, reason);
  }

  send(kind: number, payload: Uint8Array = EMPTY): boolean {
    return this.write(() => encodeFrame(kind, payload));
  }

  /** 仅在 READY 之后发送（READY 前的 STDIN / ACK 会撞上 HELLO 握手）。 */
  sendIfLive(kind: number, payload: Uint8Array): boolean {
    return this.live ? this.send(kind, payload) : false;
  }

  sendJson(kind: number, body: unknown): boolean {
    return this.write(() => encodeJsonFrame(kind, body));
  }

  /** 客户端主动收尾（已收到 EXIT / 二次信号）：优雅关闭，不再等对端回应。 */
  finish(cancelQueue = false): void {
    this.end({ kind: 'done' }, cancelQueue);
  }

  /** 致命错误：立即交回调用方，同时尽力优雅关闭 socket（让已排队的 CLOSE 帧发出）。 */
  fail(error: unknown): void {
    this.end({ kind: 'fatal', error }, true);
  }

  /** 立即放弃：丢弃排队帧、掐断 socket。 */
  abort(): void {
    if (this.outcome) return;
    this.queue.cancel();
    this.settle({ kind: 'aborted' });
    this.socket.terminate();
  }

  private end(end: ConnEnd, cancelQueue: boolean): void {
    if (this.outcome) return;
    if (cancelQueue) this.queue.cancel();
    this.settle(end);
    try {
      this.socket.close(1000, 'done');
    } catch {
      this.socket.terminate();
    }
    setTimeout(() => this.socket.terminate(), FINISH_GRACE_MS).unref?.();
  }

  private write(encode: () => Uint8Array): boolean {
    if (this.outcome || !this.opened) return false;
    try {
      this.socket.send(encode());
      this.lastSend = Date.now();
      return true;
    } catch {
      this.socket.terminate();
      return false;
    }
  }

  private settle(end: ConnEnd): void {
    if (this.outcome) return;
    this.outcome = end;
    clearInterval(this.timer);
    this.live = false;
    this.resolveSettled(end);
  }

  private handleOpen(): void {
    this.opened = true;
    this.lastRecv = Date.now();
    this.sendJson(EcKind.HELLO, this.hello);
  }

  private handleClose(code: number, reason: string): void {
    if (this.outcome) return;
    clearInterval(this.timer);
    this.live = false;
    const opened = this.opened;
    void this.queue.idle().then(() => this.settle({ kind: 'lost', code, reason, opened }));
  }

  private tick(): void {
    const now = Date.now();
    if (now - this.lastRecv >= this.timing.deadMs) {
      this.socket.terminate();
      return;
    }
    if (this.opened && now - this.lastSend >= this.timing.pingMs) this.send(EcKind.PING);
  }

  private handleMessage(data: Uint8Array): void {
    if (this.outcome) return;
    this.lastRecv = Date.now();
    try {
      for (const frame of this.decoder.push(data)) this.dispatch(frame);
    } catch (error) {
      this.fail(
        error instanceof CliError
          ? error
          : new NetworkError(`exec channel protocol error: ${errorText(error)}`)
      );
    }
  }

  private dispatch(frame: EcFrame): void {
    switch (frame.kind) {
      case EcKind.READY:
        this.live = true;
        this.handlers.ready(decodeJson<ExecReady>(frame.payload));
        return;
      case EcKind.STDIN_ACK:
        this.handlers.stdinAck(decodeJson<{ stdin: number }>(frame.payload).stdin);
        return;
      case EcKind.PING:
        this.send(EcKind.PONG);
        return;
      case EcKind.STDOUT:
      case EcKind.STDERR:
      case EcKind.EXIT:
      case EcKind.ERROR:
        this.queue.add(() => this.handlers.frame(frame));
        return;
    }
  }
}
