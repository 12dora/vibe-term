import type { Carrier, CarrierSendResult } from '../../ws/carrier';
import { FANOUT_MAX_PENDING_BYTES } from './channel-fanout';
import {
  FragmentProtocolError,
  FrameReassembler,
  fragmentFrame,
  fragmentPayloadSize,
} from './fragmenter';
import { encodeLivenessChunk, parseLivenessChunk } from './liveness';
import type { DataChannelLike } from './native';
import { copyBytes, sendBinary, toUint8Array } from './native';
import { rtcLog } from './rtc-log';

export const DC_HIGH_WATER_BYTES = 4 * 1024 * 1024;
export const DC_LOW_WATER_BYTES = 1 * 1024 * 1024;
export const DC_PRIORITY_QUEUE_CAP = 16;

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
  private readonly pendingFrames: Uint8Array[] = [];
  private readonly priorityQueue: OutboundFrame[] = [];
  private pendingBytes = 0;
  private nextFrameId = 1;
  private closed = false;
  private remainder: OutboundFrame | null = null;
  private readonly peer: string | undefined;

  constructor(channel: DataChannelLike, opts?: { reassembler?: FrameReassembler; peer?: string }) {
    this.channel = channel;
    this.peer = opts?.peer;
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
      this.flushOutbound();
      if (this.closed || this.remainder || this.priorityQueue.length > 0) return;
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
      const bytes = copyBytes(toUint8Array(msg));
      const livenessKind = parseLivenessChunk(bytes);
      if (livenessKind === 'ping') {
        this.sendLiveness('pong');
        return;
      }
      if (livenessKind === 'pong') return;
      let frame: Uint8Array | null;
      try {
        frame = this.reassembler.push(bytes);
      } catch (err) {
        if (err instanceof FragmentProtocolError) {
          this.failClosed();
          return;
        }
        throw err;
      }
      if (!frame) return;
      if (this.messageCbs.length === 0) {
        if (this.pendingBytes + frame.byteLength > FANOUT_MAX_PENDING_BYTES) {
          rtcLog('buffer overflow', {
            peer: this.peer ?? 'unknown',
            dropped: this.pendingFrames.length + 1,
          });
          this.failClosed();
          return;
        }
        this.pendingFrames.push(frame);
        this.pendingBytes += frame.byteLength;
        return;
      }
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
    channel.onError(() => {
      this.failClosed();
    });
    if (!channel.isOpen()) this.failClosed();
  }

  send(bytes: Uint8Array): CarrierSendResult {
    if (this.closed || !this.channel.isOpen()) return 'closed';
    if (this.remainder || this.channel.bufferedAmount() > DC_HIGH_WATER_BYTES) {
      return 'backpressure';
    }
    const frameId = this.allocFrameId();
    this.remainder = {
      parts: fragmentFrame(frameId, bytes, this.payloadSize),
      index: 0,
    };
    this.flushOutbound();
    if (this.closed) return 'closed';
    if (this.remainder) return 'sent';
    if (this.channel.bufferedAmount() > DC_HIGH_WATER_BYTES) return 'backpressure';
    return 'sent';
  }

  sendPriority(bytes: Uint8Array): CarrierSendResult {
    if (this.closed || !this.channel.isOpen()) return 'closed';
    if (this.priorityQueue.length >= DC_PRIORITY_QUEUE_CAP) return 'rejected';
    this.priorityQueue.push({
      parts: fragmentFrame(this.allocFrameId(), copyBytes(bytes), this.payloadSize),
      index: 0,
    });
    this.flushOutbound();
    if (this.closed) return 'closed';
    return 'sent';
  }

  hasPendingWrites(): boolean {
    return (
      this.remainder !== null ||
      this.priorityQueue.length > 0 ||
      this.bufferedAmount() > DC_HIGH_WATER_BYTES
    );
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
    const queued = this.pendingFrames.splice(0);
    this.pendingBytes = 0;
    for (const frame of queued) {
      try {
        cb(frame);
      } catch {
        // inbound listener
      }
    }
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
    if (this.closed) cb();
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

  private sendLiveness(kind: 'ping' | 'pong'): void {
    if (this.closed || !this.channel.isOpen()) return;
    if (this.channel.bufferedAmount() > DC_HIGH_WATER_BYTES) return;
    sendBinary(this.channel, encodeLivenessChunk(kind));
  }

  private allocFrameId(): number {
    const frameId = this.nextFrameId;
    this.nextFrameId = (this.nextFrameId + 1) >>> 0;
    if (this.nextFrameId === 0) this.nextFrameId = 1;
    return frameId;
  }

  private flushOutbound(): void {
    this.flushPriority();
    this.flushRemainder();
  }

  private flushPriority(): void {
    while (this.priorityQueue.length > 0 && !this.closed) {
      const frame = this.priorityQueue[0];
      if (!frame) break;
      if (!this.flushFrame(frame, true)) return;
      this.priorityQueue.shift();
    }
  }

  private flushRemainder(): void {
    const remainder = this.remainder;
    if (!remainder || this.closed) return;
    if (!this.flushFrame(remainder, false)) return;
    this.remainder = null;
  }

  private flushFrame(frame: OutboundFrame, respectHighWater: boolean): boolean {
    while (frame.index < frame.parts.length) {
      const part = frame.parts[frame.index];
      if (!part) break;
      if (respectHighWater && this.channel.bufferedAmount() > DC_HIGH_WATER_BYTES) return false;
      if (!sendBinary(this.channel, part)) {
        if (!this.channel.isOpen()) {
          this.failClosed();
          return false;
        }
        return false;
      }
      frame.index += 1;
    }
    return true;
  }

  private failClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.remainder = null;
    this.priorityQueue.length = 0;
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
