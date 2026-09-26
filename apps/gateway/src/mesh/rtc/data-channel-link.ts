import { type ByteTransport, CTL_STREAM_ID, FrameOp } from '@vibeterm/shared/link';
import { fanoutMaxPendingBytes } from './channel-fanout';
import { DC_HIGH_WATER_BYTES, DC_LOW_WATER_BYTES } from './data-channel-carrier';
import { isDcHandshakeWire } from './dc-handshake';
import { beginDcLinkProof, markDcLinkProof, ownDataChannelLink } from './dc-link-proof';
import {
  FragmentProtocolError,
  type FragmentSizing,
  FrameReassembler,
  fragmentFrame,
  fragmentSizing,
} from './fragmenter';
import {
  ChannelLiveness,
  type RtcLivenessClock,
  encodeLivenessChunk,
  parseLivenessChunk,
} from './liveness';
import type { DataChannelLike } from './native';
import { copyBytes, sendBinary, toUint8Array } from './native';
import { exitRtcLogContext, rtcLog } from './rtc-log';
import { logDataChannelClosed } from './rtc-peer-helpers';

export const DC_FLUSH_RETRY_MS = 8;

export type DataChannelLinkOptions = RtcLivenessClock & {
  reassembler?: FrameReassembler;
  peer?: string;
  /** 拨号 attempt id。关闭日志要在 ALS 结束之后还能打出来。 */
  attempt?: string;
  intervalMs?: number;
  timeoutMs?: number;
  liveness?: boolean;
};

type QueueItem = {
  parts: Uint8Array[];
  index: number;
  resolve: () => void;
  reject: (err: Error) => void;
};

function readU32LE(buf: Uint8Array, offset: number): number {
  const b0 = buf[offset];
  const b1 = buf[offset + 1];
  const b2 = buf[offset + 2];
  const b3 = buf[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) return 0;
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}

function isUrgentMuxFrame(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 5) return true;
  const streamId = readU32LE(bytes, 0);
  const op = bytes[4] ?? 0;
  if (streamId === CTL_STREAM_ID) return true;
  return op === FrameOp.WINDOW || op === FrameOp.RST || op === FrameOp.END;
}

function defaultSetTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return handle;
}

export class DataChannelLink implements ByteTransport {
  readonly channel: DataChannelLike;
  private readonly reassembler: FrameReassembler;
  private readonly sizing: FragmentSizing;
  private readonly dataCbs: Array<(bytes: Uint8Array) => void> = [];
  private readonly closeCbs: Array<(reason?: string) => void> = [];
  private readonly pendingFrames: Uint8Array[] = [];
  private pendingBytes = 0;
  private readonly controlQueue: QueueItem[] = [];
  private readonly dataQueue: QueueItem[] = [];
  private nextFrameId = 1;
  private closed = false;
  private opened: boolean;
  private closeReason = 'closed';
  private liveness: ChannelLiveness | null = null;
  private readonly peer: string | undefined;
  private readonly attempt: string | undefined;
  private readonly nowFn: () => number;
  private readonly startedAt: number;
  private wasOpen = false;
  private provenFlag = false;
  private proofGeneration: number | undefined;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private pendingPing = false;
  private pendingPong = false;
  private flushActive = false;
  private flushAgain = false;
  private flushRetryHandle: unknown = null;
  private lowThresholdDropped = false;
  private callbackDepth = 0;

  constructor(channel: DataChannelLike, opts?: DataChannelLinkOptions) {
    this.channel = channel;
    this.peer = opts?.peer;
    this.attempt = opts?.attempt;
    this.nowFn = opts?.now ?? Date.now;
    this.startedAt = this.nowFn();
    ownDataChannelLink(channel);
    this.setTimeoutFn = opts?.setTimeoutFn ?? defaultSetTimeout;
    this.clearTimeoutFn =
      opts?.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    try {
      this.sizing = fragmentSizing(channel.maxMessageSize());
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
      exitRtcLogContext(() => this.armFlushRetry(DC_FLUSH_RETRY_MS));
    });
    channel.onOpen(() => {
      exitRtcLogContext(() => {
        this.opened = true;
        this.flush();
      });
    });
    channel.onMessage((msg) => {
      if (this.closed) return;
      this.runChannelCallback(() => {
        if (isDcHandshakeWire(msg)) return;
        const bytes = copyBytes(toUint8Array(msg));
        this.liveness?.noteInbound();
        const livenessKind = parseLivenessChunk(bytes);
        if (livenessKind === 'ping') {
          this.sendLiveness('pong');
          return;
        }
        if (livenessKind === 'pong') {
          this.noteProven();
          return;
        }
        let frame: Uint8Array | null;
        try {
          frame = this.reassembler.push(bytes);
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
    });
    this.bindLifetime(opts);
  }

  get proven(): boolean {
    return this.provenFlag;
  }

  private bindLifetime(opts?: DataChannelLinkOptions): void {
    this.wasOpen = this.channel.isOpen();
    if (this.peer && this.wasOpen) this.proofGeneration = beginDcLinkProof(this.peer);
    this.channel.onClosed(() => {
      exitRtcLogContext(() => this.finishClose('channel-closed', 'remote'));
    });
    this.channel.onError((err) => {
      exitRtcLogContext(() => this.finishClose(err || 'channel-error', 'remote'));
    });
    if (!this.channel.isOpen()) this.finishClose('channel-closed', 'remote');
    if (opts?.liveness === false || this.closed) {
      this.liveness = null;
      return;
    }
    this.liveness = new ChannelLiveness({
      peer: opts?.peer,
      intervalMs: opts?.intervalMs,
      timeoutMs: opts?.timeoutMs,
      now: opts?.now,
      setTimeoutFn: opts?.setTimeoutFn,
      clearTimeoutFn: opts?.clearTimeoutFn,
      sendPing: () => this.sendLiveness('ping'),
      onTimeout: () => this.close('liveness-timeout'),
    });
    this.liveness.start();
  }

  private noteProven(): void {
    if (this.provenFlag) return;
    this.provenFlag = true;
    if (this.peer && this.proofGeneration !== undefined) {
      markDcLinkProof(this.peer, this.proofGeneration);
    }
  }

  send(bytes: Uint8Array): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error(this.closeReason));
    }
    const frameId = this.allocFrameId();
    const parts = fragmentFrame(frameId, copyBytes(bytes), this.sizing.preferred, this.sizing.max);
    const urgent = isUrgentMuxFrame(bytes);
    return new Promise((resolve, reject) => {
      const item: QueueItem = { parts, index: 0, resolve, reject };
      (urgent ? this.controlQueue : this.dataQueue).push(item);
      this.flush();
    });
  }

  onData(cb: (bytes: Uint8Array) => void): void {
    this.dataCbs.push(cb);
    const queued = this.pendingFrames.splice(0);
    this.pendingBytes = 0;
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

  private runChannelCallback(fn: () => void): void {
    if (this.closed) return;
    this.callbackDepth += 1;
    try {
      exitRtcLogContext(fn);
    } finally {
      this.setTimeoutFn(() => {
        this.callbackDepth = Math.max(0, this.callbackDepth - 1);
        if (this.closed) return;
        this.flush();
      }, DC_FLUSH_RETRY_MS);
    }
  }

  private flush(): void {
    if (!this.opened || this.closed) return;
    if (this.callbackDepth > 0) {
      this.armFlushRetry(DC_FLUSH_RETRY_MS);
      return;
    }
    if (this.flushActive) {
      this.flushAgain = true;
      return;
    }
    this.flushActive = true;
    try {
      do {
        this.flushAgain = false;
        this.flushOnce();
      } while (this.flushAgain && !this.closed);
    } finally {
      this.flushActive = false;
    }
  }

  private flushOnce(): void {
    if (this.pendingPong && this.trySendRaw(encodeLivenessChunk('pong'), true)) {
      this.pendingPong = false;
    } else if (this.pendingPong) {
      this.armFlushRetry();
      return;
    }
    if (this.pendingPing && this.trySendRaw(encodeLivenessChunk('ping'), true)) {
      this.pendingPing = false;
    } else if (this.pendingPing) {
      this.armFlushRetry();
      return;
    }
    if (!this.flushQueue(this.controlQueue, true)) return;
    if (!this.flushQueue(this.dataQueue, false)) return;
    this.restoreLowThreshold();
  }

  private flushQueue(queue: QueueItem[], urgent: boolean): boolean {
    while (queue.length > 0) {
      const item = queue[0];
      if (!item) break;
      while (item.index < item.parts.length) {
        if (!urgent && (this.pendingPing || this.pendingPong || this.controlQueue.length > 0)) {
          this.flushAgain = true;
          return true;
        }
        const part = item.parts[item.index];
        if (!part) break;
        if (!this.trySendRaw(part, urgent)) {
          this.armFlushRetry();
          return false;
        }
        item.index += 1;
      }
      queue.shift();
      item.resolve();
    }
    return true;
  }

  private trySendRaw(bytes: Uint8Array, bypassHighWater: boolean): boolean {
    if (this.closed || !this.opened || !this.channel.isOpen()) return false;
    if (this.callbackDepth > 0) return false;
    if (!bypassHighWater && this.channel.bufferedAmount() > DC_HIGH_WATER_BYTES) {
      return false;
    }
    const before = this.channel.bufferedAmount();
    const ok = sendBinary(this.channel, bytes);
    const after = this.channel.bufferedAmount();
    const accepted = ok || after > before;
    if (!accepted) {
      if (!this.channel.isOpen()) {
        this.finishClose('channel-closed', 'remote');
        return false;
      }
      this.dropLowThreshold();
      return false;
    }
    return true;
  }

  private dropLowThreshold(): void {
    if (this.lowThresholdDropped) return;
    this.lowThresholdDropped = true;
    try {
      this.channel.setBufferedAmountLowThreshold(0);
    } catch {
      // native channel may already be closed
    }
  }

  private restoreLowThreshold(): void {
    if (!this.lowThresholdDropped) return;
    if (
      this.pendingPing ||
      this.pendingPong ||
      this.controlQueue.length > 0 ||
      this.dataQueue.length > 0
    ) {
      return;
    }
    this.lowThresholdDropped = false;
    try {
      this.channel.setBufferedAmountLowThreshold(DC_LOW_WATER_BYTES);
    } catch {
      // native channel may already be closed
    }
  }

  private armFlushRetry(delayMs = DC_FLUSH_RETRY_MS): void {
    if (this.closed) return;
    if (this.flushRetryHandle != null) {
      if (delayMs > 0) return;
      this.clearFlushRetry();
    }
    this.flushRetryHandle = this.setTimeoutFn(() => {
      this.flushRetryHandle = null;
      this.flush();
    }, delayMs);
  }

  private clearFlushRetry(): void {
    if (this.flushRetryHandle == null) return;
    this.clearTimeoutFn(this.flushRetryHandle);
    this.flushRetryHandle = null;
  }

  private dispatchFrame(frame: Uint8Array): void {
    if (this.dataCbs.length === 0) {
      if (this.pendingBytes + frame.byteLength > fanoutMaxPendingBytes()) {
        rtcLog('buffer overflow', {
          peer: this.peer ?? 'unknown',
          dropped: this.pendingFrames.length + 1,
        });
        this.close('buffer-overflow');
        return;
      }
      this.pendingFrames.push(frame);
      this.pendingBytes += frame.byteLength;
      return;
    }
    for (const cb of this.dataCbs) cb(frame);
  }

  private sendLiveness(kind: 'ping' | 'pong'): void {
    if (this.closed || !this.opened) return;
    if (kind === 'pong') this.pendingPong = true;
    else this.pendingPing = true;
    this.flush();
  }

  private allocFrameId(): number {
    const frameId = this.nextFrameId;
    this.nextFrameId = (this.nextFrameId + 1) >>> 0;
    if (this.nextFrameId === 0) this.nextFrameId = 1;
    return frameId;
  }

  private finishClose(reason: string, origin: 'local' | 'remote' = 'local'): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.pendingPing = false;
    this.pendingPong = false;
    this.callbackDepth = 0;
    this.clearFlushRetry();
    this.liveness?.stop();
    this.liveness = null;
    this.reassembler.dispose();
    if (this.wasOpen) {
      logDataChannelClosed({
        peer: this.peer,
        reason,
        initiator: origin,
        attempt: this.attempt,
        lifetime_ms: Math.max(0, this.nowFn() - this.startedAt),
        proven: this.provenFlag,
      });
    }
    this.settleQueuedSends(reason);
    for (const cb of this.closeCbs) {
      try {
        cb(reason);
      } catch {
        // close listener
      }
    }
  }

  private settleQueuedSends(reason: string): void {
    const pending = this.controlQueue.splice(0).concat(this.dataQueue.splice(0));
    if (pending.length === 0) return;
    // 拆链或本端 stop 时，排队中的 WINDOW/END 调用方往往已经不再 await。
    // resolve 而不是 reject，避免变成 unhandledRejection；其它主动 close(reason) 仍 reject。
    if (reason === 'channel-closed' || reason === 'stopped') {
      for (const item of pending) item.resolve();
      return;
    }
    const err = new Error(reason);
    for (const item of pending) item.reject(err);
  }
}
