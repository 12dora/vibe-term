import { wsBorsh } from '@tmex/shared';
import type { Carrier } from './carrier';
import { carrierKindOf, logGuardEvent } from './ws-backpressure-log';

export const GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES = 1_048_576;
export const GATEWAY_WS_BACKPRESSURE_TIMEOUT_MS = 5_000;
export const GATEWAY_WS_BACKPRESSURE_PROGRESS_MS = 5_000;

interface BackpressureState {
  skippedFrame: boolean;
  timer: ReturnType<typeof setTimeout>;
  firstAt: number;
  bufferedBefore: number;
  skippedFrames: number;
  skippedBytes: number;
  frameKind: string;
  lastKind: string;
  lastFrame: string | BufferSource | undefined;
  frameBytes: number;
  lastProgressAt: number;
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
  carriersByKind: Record<string, number>;
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
    if (this.unavailable.has(carrier)) {
      return 'dropped';
    }
    if (this.states.has(carrier)) {
      this.canSend(carrier);
      this.noteSkip(carrier, frames);
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
        this.enterBackpressure(carrier, frame, frames.slice(index + 1));
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
    let bufferedAfter = 0;
    try {
      bufferedAfter = Math.max(0, carrier.bufferedAmount());
    } catch {
      bufferedAfter = 0;
    }
    logGuardEvent('backpressure drain', carrier, {
      buffered_before: state.bufferedBefore,
      buffered_after: bufferedAfter,
      skipped_frames: state.skippedFrames,
      skipped_bytes: state.skippedBytes,
      first_backpressure_at: state.firstAt,
    });
    if (state.skippedFrame) {
      this.terminate(carrier, 'backpressure_gap');
    }
    this.states.delete(carrier);
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
    const carriersByKind: Record<string, number> = {};
    for (const carrier of carriers) {
      sessions += 1;
      if (this.states.has(carrier)) backpressuredSessions += 1;
      if (this.unavailable.has(carrier)) unavailableSessions += 1;
      const kind = carrierKindOf(carrier);
      carriersByKind[kind] = (carriersByKind[kind] ?? 0) + 1;
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
      carriersByKind,
    };
  }

  private enterBackpressure(
    carrier: Carrier,
    frame: string | BufferSource,
    rest: readonly (string | BufferSource)[]
  ): BackpressureState {
    const frameBytes = frameByteLength(frame);
    let bufferedBefore = 0;
    try {
      bufferedBefore = Math.max(0, carrier.bufferedAmount());
    } catch {
      bufferedBefore = 0;
    }
    const restBytes = rest.reduce((sum, item) => sum + frameByteLength(item), 0);
    const state: BackpressureState = {
      skippedFrame: rest.length > 0,
      timer: setTimeout(() => {
        if (this.states.get(carrier) !== state) {
          return;
        }
        this.terminate(carrier, 'backpressure_timeout');
        this.states.delete(carrier);
      }, this.timeoutMs),
      firstAt: Date.now(),
      bufferedBefore,
      skippedFrames: rest.length,
      skippedBytes: restBytes,
      frameKind: frameKindOf(frame),
      lastKind: frameKindOf(frame),
      lastFrame: rest[rest.length - 1] ?? frame,
      frameBytes,
      lastProgressAt: Date.now(),
    };
    this.states.set(carrier, state);
    logGuardEvent('backpressure enter', carrier, {
      buffered_before: bufferedBefore,
      buffered_after: bufferedBefore,
      frame_kind: state.frameKind,
      frame_bytes: frameBytes,
      first_backpressure_at: state.firstAt,
      skipped_frames: state.skippedFrames,
      skipped_bytes: state.skippedBytes,
    });
    return state;
  }

  private noteSkip(carrier: Carrier, frames: readonly (string | BufferSource)[]): void {
    const state = this.states.get(carrier);
    if (!state) return;
    let bytes = 0;
    for (const frame of frames) bytes += frameByteLength(frame);
    state.skippedFrames += frames.length;
    state.skippedBytes += bytes;
    const last = frames[frames.length - 1];
    if (last !== undefined) state.lastFrame = last;
    const now = Date.now();
    if (now - state.lastProgressAt < GATEWAY_WS_BACKPRESSURE_PROGRESS_MS) return;
    state.lastProgressAt = now;
    state.lastKind = frameKindOf(state.lastFrame);
    logGuardEvent('backpressure skip', carrier, {
      buffered_before: state.bufferedBefore,
      frame_kind: state.lastKind || state.frameKind,
      first_kind: state.frameKind,
      last_kind: state.lastKind,
      first_backpressure_at: state.firstAt,
      skipped_frames: state.skippedFrames,
      skipped_bytes: state.skippedBytes,
    });
  }

  private terminate(carrier: Carrier, reason: TerminationReason): void {
    if (this.unavailable.has(carrier)) {
      return;
    }
    this.unavailable.add(carrier);
    this.terminationsByReason[reason] += 1;
    const state = this.states.get(carrier);
    logGuardEvent('terminate', carrier, {
      reason,
      buffered_before: state?.bufferedBefore ?? 0,
      skipped_frames: state?.skippedFrames ?? 0,
      skipped_bytes: state?.skippedBytes ?? 0,
      first_backpressure_at: state?.firstAt ?? 0,
    });
    this.onTerminate(reason);
    try {
      carrier.terminate();
    } catch {
      // The carrier may already be closing.
    }
  }
}

function frameKindOf(frame: string | BufferSource | undefined): string {
  if (frame === undefined) return 'raw';
  try {
    const bytes = toUint8Array(frame);
    if (!wsBorsh.checkMagic(bytes) || bytes.byteLength < 6) return 'raw';
    const kind = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(4, true);
    return kind.toString(16).padStart(4, '0');
  } catch {
    return 'raw';
  }
}

export const gatewayWebSocketSendGuard = new WebSocketSendGuard();
