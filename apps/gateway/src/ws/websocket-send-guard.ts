import { wsBorsh } from '@tmex/shared';
import type { Carrier, CarrierSendResult } from './carrier';
import { carrierKindOf, logGuardEvent } from './ws-backpressure-log';

export const GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES = 1_048_576;
/** Bun `closeOnBackpressureLimit` 硬顶。guard 在首次 −1 后丢帧，此值只拦仍往 socket 里塞的路径。 */
export const GATEWAY_WS_BACKPRESSURE_HARD_LIMIT_BYTES = 4 * 1_048_576;
export const GATEWAY_WS_BACKPRESSURE_TIMEOUT_MS = 5_000;
export const GATEWAY_WS_BACKPRESSURE_PROGRESS_MS = 5_000;
/** PONG 在缓冲低于此值时走直发路径，计入 bypassed。 */
export const GATEWAY_WS_PONG_BYPASS_BUFFERED_BYTES = 64 * 1024;

interface BackpressureState {
  skippedFrame: boolean;
  onlySkippedTerminalData: boolean;
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

type FrameStatus = CarrierSendResult | 'error' | 'unsent';

interface BatchResult {
  results: FrameStatus[];
  bufferedAmount: number | null;
}

/** 去掉空洞并转成字节，保留每帧在原数组里的下标。 */
function collectPayloads(frames: readonly (string | BufferSource)[]): {
  indexes: number[];
  payloads: Uint8Array[];
} {
  const indexes: number[] = [];
  const payloads: Uint8Array[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (frame === undefined) continue;
    indexes.push(index);
    payloads.push(toUint8Array(frame));
  }
  return { indexes, payloads };
}

function corkedBatch(
  carrier: Carrier,
  results: FrameStatus[],
  indexes: readonly number[],
  payloads: readonly Uint8Array[],
  stopOnBackpressure: boolean
): BatchResult {
  try {
    const batch = (carrier.sendMany as NonNullable<Carrier['sendMany']>).call(carrier, payloads, {
      stopOnBackpressure,
    });
    for (let i = 0; i < batch.statuses.length; i += 1) {
      const index = indexes[i];
      const status = batch.statuses[i];
      if (index !== undefined && status !== undefined) results[index] = status;
    }
    return { results, bufferedAmount: batch.bufferedAmount };
  } catch {
    const first = indexes[0];
    if (first !== undefined) results[first] = 'error';
    return { results, bufferedAmount: null };
  }
}

function sequentialBatch(
  carrier: Carrier,
  results: FrameStatus[],
  indexes: readonly number[],
  payloads: readonly Uint8Array[],
  priority: boolean,
  stopOnBackpressure: boolean
): BatchResult {
  for (let i = 0; i < payloads.length; i += 1) {
    const index = indexes[i] as number;
    const bytes = payloads[i] as Uint8Array;
    let status: CarrierSendResult;
    try {
      status = priority
        ? (carrier.sendPriority as NonNullable<Carrier['sendPriority']>).call(carrier, bytes)
        : carrier.send(bytes);
    } catch {
      results[index] = 'error';
      break;
    }
    results[index] = status;
    if (status === 'sent') continue;
    if (stopOnBackpressure || status === 'closed' || status === 'rejected') break;
  }
  return { results, bufferedAmount: null };
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

  canSend(carrier: Carrier, skippedTerminalData = false): boolean {
    if (this.unavailable.has(carrier)) {
      return false;
    }
    const state = this.states.get(carrier);
    if (!state) {
      return true;
    }
    state.skippedFrame = true;
    state.onlySkippedTerminalData &&= skippedTerminalData;
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
    if (this.bufferedAmountOf(carrier) >= GATEWAY_WS_BACKPRESSURE_HARD_LIMIT_BYTES) {
      this.terminate(carrier, 'backpressure_gap');
      return 'dropped';
    }
    if (this.states.has(carrier)) {
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

    const batch = this.deliver(carrier, frames, 'stream');
    return this.settleStreamBatch(carrier, frames, batch);
  }

  /** 扫描批结果：第一个非 sent 的帧决定整批的去向（终止 / 进背压 / 全部送达）。 */
  private settleStreamBatch(
    carrier: Carrier,
    frames: readonly (string | BufferSource)[],
    batch: BatchResult
  ): WebSocketSendStatus {
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index];
      if (frame === undefined) continue;

      const status = batch.results[index];
      if (status === undefined || status === 'unsent') break;
      if (status === 'sent') continue;

      if (status === 'backpressure' || status === 'rejected') {
        const skipped = frames.slice(status === 'rejected' ? index : index + 1);
        this.enterBackpressure(carrier, frame, skipped, batch.bufferedAmount);
        return 'backpressured';
      }

      this.terminate(carrier, 'dropped_frame');
      return 'dropped';
    }

    return 'sent';
  }

  /**
   * 把一批帧交给载体：多帧且载体支持 `sendMany` 时整批走 cork（一次写出），
   * 否则逐帧发。返回与 `frames` 等长的结果数组（未发出的位置为 `unsent`）。
   * `stream` 模式首帧非 `sent` 即停发余下帧，与逐帧循环的丢帧语义一致；
   * `priority` 模式只在 `closed`/`rejected` 时停。
   */
  private deliver(
    carrier: Carrier,
    frames: readonly (string | BufferSource)[],
    mode: 'stream' | 'priority'
  ): BatchResult {
    const results: FrameStatus[] = frames.map(() => 'unsent');
    const { indexes, payloads } = collectPayloads(frames);
    const priority = mode === 'priority' && typeof carrier.sendPriority === 'function';
    const stopOnBackpressure = mode === 'stream';

    if (payloads.length > 1 && !priority && typeof carrier.sendMany === 'function') {
      return corkedBatch(carrier, results, indexes, payloads, stopOnBackpressure);
    }
    return sequentialBatch(carrier, results, indexes, payloads, priority, stopOnBackpressure);
  }

  /**
   * 控制面优先发送：不走终端输出的 drop/defer 策略。
   * 已判定为不可用的 carrier 仍拒绝。
   * Bun / LinkStream 的 `backpressure` 表示帧已入队；`rejected` 表示未接受，不得报 sent。
   * 有 `sendPriority` 的载体（DataChannel）把控制帧送进优先队列。
   */
  sendPriorityFrames(
    carrier: Carrier,
    frames: readonly (string | BufferSource)[]
  ): WebSocketSendStatus {
    if (this.unavailable.has(carrier)) {
      return 'dropped';
    }

    const { results } = this.deliver(carrier, frames, 'priority');

    for (let index = 0; index < frames.length; index += 1) {
      if (frames[index] === undefined) continue;
      const status = results[index];
      if (status === undefined || status === 'unsent') break;
      if (status === 'error' || status === 'closed') return 'dropped';
      if (status === 'rejected') return 'backpressured';
    }

    return 'sent';
  }

  handleDrain(carrier: Carrier): void {
    const state = this.states.get(carrier);
    if (!state) {
      return;
    }
    clearTimeout(state.timer);
    const bufferedAfter = this.bufferedAmountOf(carrier);
    logGuardEvent('backpressure drain', carrier, {
      buffered_before: state.bufferedBefore,
      buffered_after: bufferedAfter,
      skipped_frames: state.skippedFrames,
      skipped_bytes: state.skippedBytes,
      first_backpressure_at: state.firstAt,
      resync: state.skippedFrame && state.onlySkippedTerminalData ? 1 : 0,
    });
    const skipped = state.skippedFrame;
    if (skipped && !state.onlySkippedTerminalData) {
      this.terminate(carrier, 'backpressure_gap');
      this.states.delete(carrier);
      return;
    }
    this.states.delete(carrier);
    if (skipped) this.sendStreamGapResync(carrier);
  }

  markStreamGap(carrier: Carrier): void {
    const state = this.states.get(carrier);
    if (state) {
      state.skippedFrame = true;
      state.onlySkippedTerminalData = false;
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
    skipped: readonly (string | BufferSource)[],
    bufferedAfterBatch: number | null = null
  ): BackpressureState {
    const frameBytes = frameByteLength(frame);
    const bufferedBefore = bufferedAfterBatch ?? this.bufferedAmountOf(carrier);
    const skippedBytes = skipped.reduce((sum, item) => sum + frameByteLength(item), 0);
    const state: BackpressureState = {
      skippedFrame: skipped.length > 0,
      onlySkippedTerminalData: skipped.every(isScreenReconstructibleTerminalFrame),
      timer: setTimeout(() => {
        if (this.states.get(carrier) !== state) {
          return;
        }
        this.terminate(carrier, 'backpressure_timeout');
        this.states.delete(carrier);
      }, this.timeoutMs),
      firstAt: Date.now(),
      bufferedBefore,
      skippedFrames: skipped.length,
      skippedBytes,
      frameKind: frameKindOf(frame),
      lastKind: frameKindOf(frame),
      lastFrame: skipped[skipped.length - 1] ?? frame,
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
    for (const frame of frames) {
      bytes += frameByteLength(frame);
      state.onlySkippedTerminalData &&= isScreenReconstructibleTerminalFrame(frame);
    }
    state.skippedFrame ||= frames.length > 0;
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

  private sendStreamGapResync(carrier: Carrier): void {
    const status = this.sendPriorityFrames(carrier, [streamPaneGapFrame() as BufferSource]);
    if (status !== 'sent') this.terminate(carrier, 'backpressure_gap');
  }

  private bufferedAmountOf(carrier: Carrier): number {
    try {
      return Math.max(0, carrier.bufferedAmount());
    } catch {
      return 0;
    }
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

function isScreenReconstructibleTerminalFrame(frame: string | BufferSource): boolean {
  try {
    const envelope = wsBorsh.decodeEnvelopeView(toUint8Array(frame));
    if (envelope.kind !== wsBorsh.KIND_CANONICAL_EVENT) return false;
    return wsBorsh.peekCanonicalPaneDataHeader(envelope.payload) !== null;
  } catch {
    return false;
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

let streamGapFrame: Uint8Array | null = null;

function streamPaneGapFrame(): Uint8Array {
  if (streamGapFrame) return streamGapFrame;
  streamGapFrame = wsBorsh.encodeEnvelope(
    wsBorsh.KIND_CANONICAL_EVENT,
    wsBorsh.encodeCanonicalEventPayload({
      SourceGap: {
        reason: wsBorsh.SOURCE_GAP_REASON_PANE_GAP,
        scope: { Stream: {} },
      },
    }),
    0
  );
  return streamGapFrame;
}

export const gatewayWebSocketSendGuard = new WebSocketSendGuard();
