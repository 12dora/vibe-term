import type { LinkStream } from '@tmex/shared/link';
import type { Carrier, CarrierSendResult } from '../ws/carrier';

export const LINK_STREAM_BACKPRESSURE_BYTES = 1024 * 1024;

export class LinkStreamCarrier implements Carrier {
  private readonly stream: LinkStream;
  private readonly highWaterMark: number;
  private readonly drainCallbacks: Array<() => void> = [];
  private readonly queue: Uint8Array[] = [];
  private pending = 0;
  private pumping = false;
  private closed = false;
  private aboveHigh = false;

  constructor(stream: LinkStream, opts?: { highWaterMark?: number }) {
    this.stream = stream;
    this.highWaterMark = opts?.highWaterMark ?? LINK_STREAM_BACKPRESSURE_BYTES;
    stream.onAbort(() => {
      this.closed = true;
    });
    void stream.closed.then(() => {
      this.closed = true;
    });
  }

  send(bytes: Uint8Array): CarrierSendResult {
    if (this.closed) return 'closed';
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

  close(_code: number, _reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.stream.end();
    } catch {
      // already ended
    }
  }

  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.stream.reset('carrier-terminate');
    } catch {
      // already reset
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
    } finally {
      this.pumping = false;
    }
  }
}
