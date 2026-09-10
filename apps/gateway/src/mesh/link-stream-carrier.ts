import type { LinkStream } from '@vibeterm/shared/link';
import { config } from '../config';
import type { Carrier, CarrierLogContext, CarrierSendResult } from '../ws/carrier';
import { encodeTerminalStreamClose, isTerminalStreamCloseCode } from './stream-close-code';

/**
 * 转发会话的在途上限：载体队列 + 已交给 mux 但对端还没回信用的字节。默认 256 KiB
 * （`VIBETERM_LINK_STREAM_INFLIGHT_BYTES` 可调）。原先只看载体队列、上限 1 MiB，叠上
 * mux 的 1 MiB 窗口后每跳能囤 2 MiB，慢上行时每个 PONG 前面都排着几百毫秒的输出。
 */
export const LINK_STREAM_BACKPRESSURE_BYTES = config.linkStreamInflightBytes;
/** 优先队列上限：控制帧都是几十字节，够深就行，满了直接拒绝而不是把在途撑大。 */
export const LINK_STREAM_PRIORITY_QUEUE_CAP = 16;
export const LINK_STREAM_PRIORITY_QUEUE_BYTES = 64 * 1024;

export class LinkStreamCarrier implements Carrier {
  readonly logContext: CarrierLogContext;
  private readonly stream: LinkStream;
  private readonly highWaterMark: number;
  private readonly lowWaterMark: number;
  private readonly drainCallbacks: Array<() => void> = [];
  private readonly closeCallbacks: Array<() => void> = [];
  private readonly queue: Uint8Array[] = [];
  private readonly priorityQueue: Uint8Array[] = [];
  private pending = 0;
  private priorityPending = 0;
  /** 正在 write() 的那一块的总字节；出队即从 pending 挪到这里，保证一段字节只算一次。 */
  private writing = 0;
  private writingBase = 0;
  private priorityHandedDuringWrite = 0;
  private pumping = false;
  private priorityPumping = false;
  private closing = false;
  private closed = false;
  private aboveHigh = false;

  constructor(
    stream: LinkStream,
    opts?: { highWaterMark?: number; logContext?: CarrierLogContext }
  ) {
    this.stream = stream;
    this.highWaterMark = opts?.highWaterMark ?? LINK_STREAM_BACKPRESSURE_BYTES;
    this.lowWaterMark = Math.max(1, Math.floor(this.highWaterMark / 2));
    this.logContext = { kind: 'mesh_link_stream', ...opts?.logContext };
    stream.reservePriorityCredit?.();
    stream.onSendWindowCredit?.(() => this.maybeDrain());
    stream.onAbort(() => {
      this.closed = true;
      this.closing = true;
      this.discardQueues();
      this.emitClose();
    });
    void stream.closed.then(() => {
      this.closed = true;
      this.closing = true;
      this.emitClose();
    });
  }

  send(bytes: Uint8Array): CarrierSendResult {
    if (this.closed || this.closing) return 'closed';
    const copy = bytes.slice();
    this.queue.push(copy);
    this.pending += copy.byteLength;
    void this.pump();
    if (this.inflight() > this.highWaterMark) {
      this.aboveHigh = true;
      return 'backpressure';
    }
    return 'sent';
  }

  /**
   * 控制面优先发送（PONG / DEVICE_LATENCY）。走独立的有界队列与独立的写链：mux 侧的
   * 优先写不排在普通写后面，还能动用预留信用，所以即使普通队列积压、发送窗口被终端
   * 输出吃干净，优先帧仍会在下一个消息边界发出。队列满返回 `rejected`（调用方按背压
   * 处理），不退回普通队列——那等于又排到积压后面。
   */
  sendPriority(bytes: Uint8Array): CarrierSendResult {
    if (this.closed || this.closing) return 'closed';
    if (this.priorityQueue.length >= LINK_STREAM_PRIORITY_QUEUE_CAP) return 'rejected';
    if (this.priorityPending + bytes.byteLength > LINK_STREAM_PRIORITY_QUEUE_BYTES) {
      return 'rejected';
    }
    const copy = bytes.slice();
    this.priorityQueue.push(copy);
    this.priorityPending += copy.byteLength;
    void this.pumpPriority();
    return 'sent';
  }

  /**
   * 单会话在途字节：普通队列 + mux 未回信用。不含优先队列——它有独立硬上限，
   * 也不该把 guard 推进背压/终止判定。
   */
  bufferedAmount(): number {
    return this.inflight();
  }

  /** 还有没写完的东西，或在途仍在高水位之上。 */
  hasPendingWrites(): boolean {
    if (this.queue.length > 0 || this.priorityQueue.length > 0) return true;
    return this.inflight() > this.highWaterMark;
  }

  onDrain(cb: () => void): void {
    this.drainCallbacks.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeCallbacks.push(cb);
  }

  /**
   * 终止性关闭码（会话失效 / 分享结束）用 RST 携带 `code:reason`，让 Hub 直接把关闭码
   * 透给浏览器而不是当成链路抖动去 failover；其余关闭码保持原来的干净半关闭。
   */
  close(code: number, reason: string): void {
    if (this.closed || this.closing) return;
    if (isTerminalStreamCloseCode(code)) {
      this.closed = true;
      this.closing = true;
      this.discardQueues();
      try {
        this.stream.reset(encodeTerminalStreamClose(code, reason));
      } catch {
        // already reset
      }
      this.emitClose();
      return;
    }
    this.closing = true;
    void this.pump();
  }

  terminate(): void {
    this.closed = true;
    this.closing = true;
    this.discardQueues();
    this.emitClose();
    try {
      this.stream.reset('carrier-terminate');
    } catch {
      // already reset
    }
  }

  private sentBytes(): number {
    return Math.max(0, this.stream.sentBytes ?? 0);
  }

  /**
   * 正在 write() 的那一块还没占到信用的部分。已占信用的部分由 `outstandingBytes` 记账，
   * 两边加起来每段字节只算一次。期间的优先帧也会推高 `sentBytes`，从增量里扣掉——扣多了
   * 只会让在途算大一点（偏向背压），不会把上限撑破。
   */
  private writingRemaining(): number {
    if (this.writing === 0) return 0;
    const credited = Math.max(
      0,
      this.sentBytes() - this.writingBase - this.priorityHandedDuringWrite
    );
    return Math.max(0, this.writing - credited);
  }

  private inflight(): number {
    const outstanding = Math.max(0, this.stream.outstandingBytes ?? 0);
    return this.pending + this.writingRemaining() + outstanding;
  }

  private discardQueues(): void {
    this.queue.length = 0;
    this.priorityQueue.length = 0;
    this.pending = 0;
    this.priorityPending = 0;
    this.writing = 0;
  }

  private emitClose(): void {
    const cbs = this.closeCallbacks.splice(0);
    for (const cb of cbs) {
      try {
        cb();
      } catch {
        // close listener
      }
    }
  }

  /** 迟滞：跌回高水位一半才放行，避免在阈值上反复进出背压。 */
  private maybeDrain(): void {
    if (!this.aboveHigh || this.closed) return;
    if (this.inflight() > this.lowWaterMark) return;
    this.aboveHigh = false;
    for (const cb of this.drainCallbacks) {
      try {
        cb();
      } catch {
        // drain listener
      }
    }
  }

  private async writeChunk(chunk: Uint8Array, priority: boolean): Promise<boolean> {
    try {
      await this.stream.write(chunk, priority ? { priority: true } : undefined);
      return true;
    } catch {
      this.closed = true;
      this.discardQueues();
      return false;
    }
  }

  /** 半关闭只能排在两条队列都空、两个泵都闲之后，否则 END 会把已收下的优先帧作废。 */
  private canFinishClose(): boolean {
    return (
      this.closing &&
      !this.closed &&
      this.queue.length === 0 &&
      this.priorityQueue.length === 0 &&
      !this.priorityPumping
    );
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const chunk = this.queue.shift();
        if (!chunk) break;
        this.pending = Math.max(0, this.pending - chunk.byteLength);
        this.writing = chunk.byteLength;
        this.writingBase = this.sentBytes();
        this.priorityHandedDuringWrite = 0;
        const ok = await this.writeChunk(chunk, false);
        this.writing = 0;
        if (!ok) return;
        this.maybeDrain();
      }
      if (this.canFinishClose()) {
        try {
          await this.stream.end();
        } catch {
          // already ended
        }
        this.closed = true;
      }
    } finally {
      this.pumping = false;
      if (!this.closed && this.queue.length > 0) {
        void this.pump();
      }
    }
  }

  private async pumpPriority(): Promise<void> {
    if (this.priorityPumping) return;
    this.priorityPumping = true;
    try {
      while (this.priorityQueue.length > 0 && !this.closed) {
        const chunk = this.priorityQueue.shift();
        if (!chunk) break;
        this.priorityHandedDuringWrite += chunk.byteLength;
        if (!(await this.writeChunk(chunk, true))) return;
        this.priorityPending = Math.max(0, this.priorityPending - chunk.byteLength);
      }
    } finally {
      this.priorityPumping = false;
      if (!this.closed) {
        if (this.priorityQueue.length > 0) void this.pumpPriority();
        // 最后一帧优先写落地了才轮到 END：普通泵已经跑完时由这里把它重新叫起来。
        else if (this.closing) void this.pump();
      }
    }
  }
}
