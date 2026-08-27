import type { Carrier, CarrierSendResult } from '../../ws/carrier';
import {
  FragmentProtocolError,
  FrameReassembler,
  fragmentFrame,
  fragmentPayloadSize,
} from './fragmenter';
import type { DataChannelLike } from './native';
import { copyBytes, sendBinary, toUint8Array } from './native';

export const DC_HIGH_WATER_BYTES = 4 * 1024 * 1024;
export const DC_LOW_WATER_BYTES = 1 * 1024 * 1024;

type OutboundFrame = {
  parts: Uint8Array[];
  index: number;
};

export class DataChannelCarrier implements Carrier {
  readonly channel: DataChannelLike;
  private readonly reassembler: FrameReassembler;
  private readonly payloadSize: number;
  private readonly drainCbs: Array<() => void> = [];
  private readonly messageCbs: Array<(bytes: Uint8Array) => void> = [];
  private readonly closeCbs: Array<() => void> = [];
  private nextFrameId = 1;
  private closed = false;
  private remainder: OutboundFrame | null = null;

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
    channel.setBufferedAmountLowThreshold(DC_LOW_WATER_BYTES);
    channel.onBufferedAmountLow(() => {
      this.flushRemainder();
      if (this.closed || this.remainder) return;
      for (const cb of this.drainCbs) {
        try {
          cb();
        } catch {
          // drain listener
        }
      }
    });
    channel.onMessage((msg) => {
      if (this.closed) return;
      let frame: Uint8Array | null;
      try {
        frame = this.reassembler.push(copyBytes(toUint8Array(msg)));
      } catch (err) {
        if (err instanceof FragmentProtocolError) {
          this.failClosed();
          return;
        }
        throw err;
      }
      if (!frame) return;
      for (const cb of this.messageCbs) {
        try {
          cb(frame);
        } catch {
          // inbound listener
        }
      }
    });
    channel.onClosed(() => {
      this.failClosed();
    });
  }

  send(bytes: Uint8Array): CarrierSendResult {
    if (this.closed || !this.channel.isOpen()) return 'closed';
    if (this.remainder || this.channel.bufferedAmount() > DC_HIGH_WATER_BYTES) {
      return 'backpressure';
    }
    const frameId = this.nextFrameId++ >>> 0;
    this.remainder = {
      parts: fragmentFrame(frameId, bytes, this.payloadSize),
      index: 0,
    };
    this.flushRemainder();
    if (this.closed) return 'closed';
    if (this.remainder) return 'sent';
    if (this.channel.bufferedAmount() > DC_HIGH_WATER_BYTES) return 'backpressure';
    return 'sent';
  }

  bufferedAmount(): number {
    try {
      return this.channel.bufferedAmount();
    } catch {
      return 0;
    }
  }

  onDrain(cb: () => void): void {
    this.drainCbs.push(cb);
  }

  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.messageCbs.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  close(_code: number, _reason: string): void {
    this.failClosed();
    try {
      this.channel.close();
    } catch {
      // already closed
    }
  }

  terminate(): void {
    this.close(1006, 'terminated');
  }

  private flushRemainder(): void {
    const remainder = this.remainder;
    if (!remainder || this.closed) return;
    while (remainder.index < remainder.parts.length) {
      const part = remainder.parts[remainder.index];
      if (!part) break;
      if (!sendBinary(this.channel, part)) {
        if (!this.channel.isOpen()) {
          this.failClosed();
          return;
        }
        return;
      }
      remainder.index += 1;
    }
    this.remainder = null;
  }

  private failClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.remainder = null;
    this.reassembler.dispose();
    try {
      this.channel.close();
    } catch {
      // already closed
    }
    for (const cb of this.closeCbs) {
      try {
        cb();
      } catch {
        // close listener
      }
    }
  }
}
