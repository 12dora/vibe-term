import type { LinkStream } from '@tmex/shared/link';
import type { Carrier, CarrierLogContext, CarrierSendResult } from '../ws/carrier';
import { encodeTerminalStreamClose, isTerminalStreamCloseCode } from './stream-close-code';

export const LINK_STREAM_BACKPRESSURE_BYTES = 1024 * 1024;

export class LinkStreamCarrier implements Carrier {
  readonly logContext: CarrierLogContext;
  private readonly stream: LinkStream;
  private readonly highWaterMark: number;
  private readonly drainCallbacks: Array<() => void> = [];
  private readonly closeCallbacks: Array<() => void> = [];
  private readonly queue: Uint8Array[] = [];
  private pending = 0;
  private pumping = false;
  private closing = false;
  private closed = false;
  private aboveHigh = false;

  constructor(
    stream: LinkStream,
    opts?: { highWaterMark?: number; logContext?: CarrierLogContext }
  ) {
    this.stream = stream;
    this.highWaterMark = opts?.highWaterMark ?? LINK_STREAM_BACKPRESSURE_BYTES;
    this.logContext = { kind: 'mesh_link_stream', ...opts?.logContext };
    stream.onAbort(() => {
      this.closed = true;
      this.closing = true;
      this.queue.length = 0;
      this.pending = 0;
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
    if (this.pending > this.highWaterMark) {
      this.aboveHigh = true;
      return 'backpressure';
    }
    return 'sent';
  }

  bufferedAmount(): number {
    return this.pending;
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
      this.queue.length = 0;
      this.pending = 0;
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
    this.queue.length = 0;
    this.pending = 0;
    this.emitClose();
    try {
      this.stream.reset('carrier-terminate');
    } catch {
      // already reset
    }
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

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const chunk = this.queue.shift();
        if (!chunk) break;
        try {
          await this.stream.write(chunk);
        } catch {
          this.closed = true;
          this.queue.length = 0;
          this.pending = 0;
          return;
        }
        this.pending = Math.max(0, this.pending - chunk.byteLength);
        if (this.aboveHigh && this.pending <= this.highWaterMark) {
          this.aboveHigh = false;
          for (const cb of this.drainCallbacks) {
            try {
              cb();
            } catch {
              // drain listener
            }
          }
        }
      }
      if (this.closing && !this.closed && this.queue.length === 0) {
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
}
