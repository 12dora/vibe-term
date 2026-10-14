// exec 通道的本地 IO 侧：严格有序的输出写入 + ACK 计数，以及带流控的 stdin 发送。

import {
  EC_ACK_BYTES,
  EC_CHUNK_BYTES,
  EC_HEADER_BYTES,
  EC_WINDOW_BYTES,
  EcKind,
  StdinOutbox,
} from '@vibeterm/shared/exec-channel';

export type ExecWriter = (bytes: Uint8Array) => Promise<void> | void;

/** 串行任务队列：任务按入队顺序逐个 await；一旦有任务抛错，后续任务全部跳过。 */
export class OrderedQueue {
  private tail: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(private readonly onError: (error: unknown) => void) {}

  add(task: () => Promise<void> | void): void {
    this.tail = this.tail.then(async () => {
      if (this.failed) return;
      try {
        await task();
      } catch (error) {
        this.failed = true;
        this.onError(error);
      }
    });
  }

  /** 丢弃尚未开始的任务（进行中的任务仍会自然结束）。 */
  cancel(): void {
    this.failed = true;
  }

  idle(): Promise<void> {
    return this.tail;
  }
}

/**
 * 输出落盘记账：只有写入完成（含 fd 背压）的帧才计入客户端 out 偏移；
 * 偏移累计到 256 KiB 或距上一帧 200 ms 时回 ACK。
 */
export class OutputSink {
  private offsetBytes = 0;
  private ackedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly stdout: ExecWriter,
    private readonly stderr: ExecWriter,
    private readonly sendAck: (out: number) => boolean,
    private readonly ackDelayMs: number
  ) {}

  get offset(): number {
    return this.offsetBytes;
  }

  async write(kind: number, payload: Uint8Array): Promise<void> {
    if (payload.byteLength > 0) {
      await (kind === EcKind.STDOUT ? this.stdout(payload) : this.stderr(payload));
    }
    this.count(payload.byteLength);
  }

  count(payloadBytes: number): void {
    this.offsetBytes += EC_HEADER_BYTES + payloadBytes;
    if (this.offsetBytes - this.ackedBytes >= EC_ACK_BYTES) {
      this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.ackDelayMs);
    this.timer.unref?.();
  }

  /** 立即回 ACK（EXIT 之后、重连成功之后用 force 重发）；链路不通时静默。 */
  flush(force = false): void {
    this.clearTimer();
    const pending = this.offsetBytes > this.ackedBytes || (force && this.offsetBytes > 0);
    if (pending && this.sendAck(this.offsetBytes)) {
      this.ackedBytes = this.offsetBytes;
    }
  }

  dispose(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

export type StdinSender = (kind: number, payload: Uint8Array) => boolean;

function toBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === 'string') return Buffer.from(chunk);
  const view = chunk as Uint8Array;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/**
 * stdin 发送：读本地流 → outbox（保留未确认字节）→ STDIN 帧。
 * 上线（已写出）的字节永远不超过 `acked + window`：超出部分留在 outbox，等 STDIN_ACK 再发；
 * 未确认字节逼近窗口时同时 pause 本地流。链路断开期间只入 outbox，重连后由 `resend`
 * 从服务端已接收的偏移补发。
 */
export class StdinPump {
  private readonly outbox = new StdinOutbox();
  private ended = false;
  private eofSent = false;
  private paused = false;
  private wire = 0;
  private windowBytes = EC_WINDOW_BYTES;
  private readonly onData = (chunk: unknown) => this.handleData(toBytes(chunk));
  private readonly onEnd = () => this.handleEnd();

  constructor(
    private readonly source: NodeJS.ReadableStream,
    private readonly send: StdinSender
  ) {}

  get unacked(): number {
    return this.outbox.unacked;
  }

  start(windowBytes: number): void {
    this.windowBytes = windowBytes;
    this.source.on('data', this.onData);
    this.source.on('end', this.onEnd);
    this.source.on('error', this.onEnd);
    this.source.resume();
  }

  stop(): void {
    this.source.removeListener('data', this.onData);
    this.source.removeListener('end', this.onEnd);
    this.source.removeListener('error', this.onEnd);
    this.source.pause();
  }

  ack(offset: number): void {
    this.outbox.ack(offset);
    this.pump();
    this.updateFlow();
  }

  /** 重连后按服务端已接收偏移补发；偏移不可信（超出已发送范围 / 已被丢弃）返回 false。 */
  resend(stdinOffset: number, stdinClosed: boolean): boolean {
    if (!this.outbox.ack(stdinOffset)) return false;
    if (!this.outbox.pendingFrom(stdinOffset)) return false;
    this.wire = stdinOffset;
    this.eofSent = stdinClosed;
    this.pump();
    this.updateFlow();
    return true;
  }

  private handleData(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.outbox.push(bytes);
    this.pump();
    this.updateFlow();
  }

  private handleEnd(): void {
    if (this.ended) return;
    this.ended = true;
    this.pump();
  }

  /** 把 outbox 里允许上线的部分发出去；链路不通时 send 返回 false，偏移不前进。 */
  private pump(): void {
    this.wire = Math.max(this.wire, this.outbox.acked);
    const allowed = Math.min(this.outbox.sent, this.outbox.acked + this.windowBytes);
    if (allowed > this.wire) this.sendRange(allowed - this.wire);
    if (this.ended && !this.eofSent && this.wire === this.outbox.sent) {
      this.eofSent = this.send(EcKind.STDIN_EOF, new Uint8Array(0));
    }
  }

  private sendRange(budget: number): void {
    let left = budget;
    for (const chunk of this.outbox.pendingFrom(this.wire) ?? []) {
      if (left <= 0) return;
      const piece = chunk.byteLength <= left ? chunk : chunk.subarray(0, left);
      if (!this.send(EcKind.STDIN, piece)) return;
      this.wire += piece.byteLength;
      left -= piece.byteLength;
    }
  }

  /** 单个数据块可能比窗口余量大，所以提前一个块长停读，尽量让 outbox 不越过窗口。 */
  private updateFlow(): void {
    if (this.ended) return;
    const limit = Math.max(1, this.windowBytes - EC_CHUNK_BYTES);
    const shouldPause = this.outbox.unacked >= limit;
    if (shouldPause === this.paused) return;
    this.paused = shouldPause;
    if (shouldPause) this.source.pause();
    else this.source.resume();
  }
}
