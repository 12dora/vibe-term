import type { Carrier } from './carrier';

export const GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES = 1_048_576;
export const GATEWAY_WS_BACKPRESSURE_TIMEOUT_MS = 5_000;

interface BackpressureState {
  skippedFrame: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface WebSocketSendGuardOptions {
  timeoutMs?: number;
  onTerminate?: (
    reason: 'backpressure_gap' | 'backpressure_timeout' | 'dropped_frame' | 'oversized_frame'
  ) => void;
}

type TerminationReason = Parameters<NonNullable<WebSocketSendGuardOptions['onTerminate']>>[0];

export type WebSocketSendStatus = 'sent' | 'backpressured' | 'dropped';

export interface WebSocketSendGuardStats {
  sessions: number;
  backpressuredSessions: number;
  unavailableSessions: number;
  queuedBytes: number;
  queuedBytesLimit: number;
  perSessionBytesLimit: number;
  backpressureTimeoutMs: number;
  terminationsByReason: Record<TerminationReason, number>;
}

function frameByteLength(frame: string | BufferSource): number {
  if (typeof frame === 'string') {
    return new TextEncoder().encode(frame).byteLength;
  }
  return frame.byteLength;
}

function toUint8Array(frame: string | BufferSource): Uint8Array {
  if (typeof frame === 'string') {
    return new TextEncoder().encode(frame);
  }
  if (frame instanceof Uint8Array) {
    return frame;
  }
  if (frame instanceof ArrayBuffer) {
    return new Uint8Array(frame);
  }
  return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
}

export class WebSocketSendGuard {
  private readonly states = new WeakMap<Carrier, BackpressureState>();
  private readonly unavailable = new WeakSet<Carrier>();
  private readonly timeoutMs: number;
  private readonly onTerminate: NonNullable<WebSocketSendGuardOptions['onTerminate']>;
  private readonly terminationsByReason: Record<TerminationReason, number> = {
    backpressure_gap: 0,
    backpressure_timeout: 0,
    dropped_frame: 0,
    oversized_frame: 0,
  };

  constructor(options: WebSocketSendGuardOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? GATEWAY_WS_BACKPRESSURE_TIMEOUT_MS;
    this.onTerminate =
      options.onTerminate ??
      ((reason) => {
        console.warn(`[ws] terminating slow client: ${reason}`);
      });
  }

  canSend(carrier: Carrier): boolean {
    if (this.unavailable.has(carrier)) {
      return false;
    }
    const state = this.states.get(carrier);
    if (!state) {
      return true;
    }
    state.skippedFrame = true;
    return false;
  }

  isBackpressured(carrier: Carrier): boolean {
    return this.states.has(carrier);
  }

  sendFrames(
    carrier: Carrier,
    frames: readonly (string | BufferSource)[],
    maxFrameBytes?: number | null
  ): boolean {
    return this.sendFramesStatus(carrier, frames, maxFrameBytes) === 'sent';
  }

  sendFramesStatus(
    carrier: Carrier,
    frames: readonly (string | BufferSource)[],
    maxFrameBytes?: number | null
  ): WebSocketSendStatus {
    if (!this.canSend(carrier)) {
      return 'dropped';
    }

    if (
      maxFrameBytes != null &&
      Number.isSafeInteger(maxFrameBytes) &&
      maxFrameBytes > 0 &&
      frames.some((frame) => frame !== undefined && frameByteLength(frame) > maxFrameBytes)
    ) {
      this.terminate(carrier, 'oversized_frame');
      return 'dropped';
    }

    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index];
      if (frame === undefined) {
        continue;
      }

      let status: ReturnType<Carrier['send']>;
      try {
        status = carrier.send(toUint8Array(frame));
      } catch {
        this.terminate(carrier, 'dropped_frame');
        return 'dropped';
      }

      if (status === 'backpressure') {
        const state: BackpressureState = {
          skippedFrame: index + 1 < frames.length,
          timer: setTimeout(() => {
            if (this.states.get(carrier) !== state) {
              return;
            }
            this.states.delete(carrier);
            this.terminate(carrier, 'backpressure_timeout');
          }, this.timeoutMs),
        };
        this.states.set(carrier, state);
        return 'backpressured';
      }

      if (status === 'closed') {
        this.terminate(carrier, 'dropped_frame');
        return 'dropped';
      }
    }

    return 'sent';
  }

  handleDrain(carrier: Carrier): void {
    const state = this.states.get(carrier);
    if (!state) {
      return;
    }
    clearTimeout(state.timer);
    this.states.delete(carrier);
    if (state.skippedFrame) {
      this.terminate(carrier, 'backpressure_gap');
    }
  }

  markStreamGap(carrier: Carrier): void {
    const state = this.states.get(carrier);
    if (state) {
      state.skippedFrame = true;
    }
  }

  forget(carrier: Carrier): void {
    const state = this.states.get(carrier);
    if (state) {
      clearTimeout(state.timer);
      this.states.delete(carrier);
    }
    this.unavailable.delete(carrier);
  }

  snapshotStats(carriers: Iterable<Carrier>): WebSocketSendGuardStats {
    let sessions = 0;
    let backpressuredSessions = 0;
    let unavailableSessions = 0;
    let queuedBytes = 0;
    for (const carrier of carriers) {
      sessions += 1;
      if (this.states.has(carrier)) backpressuredSessions += 1;
      if (this.unavailable.has(carrier)) unavailableSessions += 1;
      try {
        queuedBytes += Math.max(0, carrier.bufferedAmount());
      } catch {
        // A concurrently closing carrier contributes zero queued bytes.
      }
    }
    return {
      sessions,
      backpressuredSessions,
      unavailableSessions,
      queuedBytes,
      queuedBytesLimit: sessions * GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES,
      perSessionBytesLimit: GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES,
      backpressureTimeoutMs: this.timeoutMs,
      terminationsByReason: { ...this.terminationsByReason },
    };
  }

  private terminate(carrier: Carrier, reason: TerminationReason): void {
    if (this.unavailable.has(carrier)) {
      return;
    }
    this.unavailable.add(carrier);
    this.terminationsByReason[reason] += 1;
    this.onTerminate(reason);
    try {
      carrier.terminate();
    } catch {
      // The carrier may already be closing.
    }
  }
}

export const gatewayWebSocketSendGuard = new WebSocketSendGuard();
