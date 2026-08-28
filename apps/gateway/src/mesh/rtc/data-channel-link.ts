import type { ByteTransport } from '@tmex/shared/link';
import { DC_HIGH_WATER_BYTES, DC_LOW_WATER_BYTES } from './data-channel-carrier';
import {
  FragmentProtocolError,
  FrameReassembler,
  fragmentFrame,
  fragmentPayloadSize,
} from './fragmenter';
import type { DataChannelLike } from './native';
import { copyBytes, sendBinary, toUint8Array } from './native';

type QueueItem = {
  parts: Uint8Array[];
  index: number;
  resolve: () => void;
  reject: (err: Error) => void;
};

export class DataChannelLink implements ByteTransport {
  readonly channel: DataChannelLike;
  private readonly reassembler: FrameReassembler;
  private readonly payloadSize: number;
  private readonly dataCbs: Array<(bytes: Uint8Array) => void> = [];
  private readonly closeCbs: Array<(reason?: string) => void> = [];
  private readonly pendingFrames: Uint8Array[] = [];
  private readonly queue: QueueItem[] = [];
  private nextFrameId = 1;
  private closed = false;
  private opened: boolean;
  private closeReason = 'closed';

  constructor(channel: DataChannelLike, opts?: { reassembler?: FrameReassembler }) {
    this.channel = channel;
    try {
      this.payloadSize = fragmentPayloadSize(channel.maxMessageSize());
    } catch (err) {
      try {
        channel.close();
      } catch {
        // already closed
      }
      throw err;
    }
    this.reassembler = opts?.reassembler ?? new FrameReassembler();
    this.opened = channel.isOpen();
    channel.setBufferedAmountLowThreshold(DC_LOW_WATER_BYTES);
    channel.onBufferedAmountLow(() => {
      this.flush();
    });
    channel.onOpen(() => {
      this.opened = true;
      this.flush();
    });
    channel.onMessage((msg) => {
      if (this.closed) return;
      let frame: Uint8Array | null;
      try {
        frame = this.reassembler.push(copyBytes(toUint8Array(msg)));
      } catch (err) {
        if (err instanceof FragmentProtocolError) {
          this.finishClose('fragment-protocol');
          try {
            this.channel.close();
          } catch {
            // already closed
          }
          return;
        }
        throw err;
      }
      if (!frame) return;
      this.dispatchFrame(frame);
    });
    channel.onClosed(() => {
      this.finishClose('channel-closed');
    });
    channel.onError((err) => {
      this.finishClose(err || 'channel-error');
    });
    if (!channel.isOpen()) this.finishClose('channel-closed');
  }

  send(bytes: Uint8Array): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error(this.closeReason));
    }
    const frameId = this.nextFrameId++ >>> 0;
    const parts = fragmentFrame(frameId, copyBytes(bytes), this.payloadSize);
    return new Promise((resolve, reject) => {
      this.queue.push({ parts, index: 0, resolve, reject });
      this.flush();
    });
  }

  onData(cb: (bytes: Uint8Array) => void): void {
    this.dataCbs.push(cb);
    const queued = this.pendingFrames.splice(0);
    for (const frame of queued) cb(frame);
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeCbs.push(cb);
    if (this.closed) cb(this.closeReason);
  }

  close(reason?: string): void {
    this.finishClose(reason ?? 'closed');
    try {
      this.channel.close();
    } catch {
      // already closed
    }
  }

  private flush(): void {
    if (!this.opened || this.closed) return;
    while (this.queue.length > 0) {
      const item = this.queue[0];
      if (!item) break;
      while (item.index < item.parts.length) {
        if (this.channel.bufferedAmount() > DC_HIGH_WATER_BYTES) return;
        const part = item.parts[item.index];
        if (!part) break;
        if (!sendBinary(this.channel, part)) {
          if (!this.channel.isOpen()) {
            this.finishClose('channel-closed');
            return;
          }
          return;
        }
        item.index += 1;
      }
      this.queue.shift();
      item.resolve();
    }
  }

  private dispatchFrame(frame: Uint8Array): void {
    if (this.dataCbs.length === 0) {
      if (this.pendingFrames.length >= 32) this.pendingFrames.shift();
      this.pendingFrames.push(frame);
      return;
    }
    for (const cb of this.dataCbs) cb(frame);
  }

  private finishClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.reassembler.dispose();
    const pending = this.queue.splice(0);
    const err = new Error(reason);
    for (const item of pending) {
      item.reject(err);
    }
    for (const cb of this.closeCbs) {
      try {
        cb(reason);
      } catch {
        // close listener
      }
    }
  }
}
