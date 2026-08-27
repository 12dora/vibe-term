import type { Carrier, CarrierSendResult } from '../../ws/carrier';
import { FRAGMENT_PAYLOAD_SIZE, FrameReassembler, fragmentFrame } from './fragmenter';
import type { DataChannelLike } from './native';
import { copyBytes, sendBinary, toUint8Array } from './native';

export const DC_HIGH_WATER_BYTES = 4 * 1024 * 1024;
export const DC_LOW_WATER_BYTES = 1 * 1024 * 1024;

export class DataChannelCarrier implements Carrier {
  readonly channel: DataChannelLike;
  private readonly reassembler: FrameReassembler;
  private readonly drainCbs: Array<() => void> = [];
  private readonly messageCbs: Array<(bytes: Uint8Array) => void> = [];
  private readonly closeCbs: Array<() => void> = [];
  private nextFrameId = 1;
  private closed = false;

  constructor(channel: DataChannelLike, opts?: { reassembler?: FrameReassembler }) {
    this.channel = channel;
    this.reassembler = opts?.reassembler ?? new FrameReassembler();
    channel.setBufferedAmountLowThreshold(DC_LOW_WATER_BYTES);
    channel.onBufferedAmountLow(() => {
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
      const frame = this.reassembler.push(copyBytes(toUint8Array(msg)));
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
      this.closed = true;
      for (const cb of this.closeCbs) {
        try {
          cb();
        } catch {
          // close listener
        }
      }
    });
  }

  send(bytes: Uint8Array): CarrierSendResult {
    if (this.closed || !this.channel.isOpen()) return 'closed';
    const frameId = this.nextFrameId++ >>> 0;
    const parts = fragmentFrame(frameId, bytes, FRAGMENT_PAYLOAD_SIZE);
    for (const part of parts) {
      if (!sendBinary(this.channel, part)) {
        if (!this.channel.isOpen()) {
          this.closed = true;
          return 'closed';
        }
        return 'backpressure';
      }
    }
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
    if (this.closed) return;
    this.closed = true;
    try {
      this.channel.close();
    } catch {
      // already closed
    }
  }

  terminate(): void {
    this.close(1006, 'terminated');
  }
}
