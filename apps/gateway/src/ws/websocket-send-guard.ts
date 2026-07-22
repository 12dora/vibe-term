import type { ServerWebSocket } from 'bun';

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

function negotiatedFrameLimit(ws: ServerWebSocket<unknown>): number | null {
  const state = (
    ws as unknown as {
      data?: { borshState?: { maxFrameBytes?: unknown } };
    }
  ).data?.borshState;
  const value = state?.maxFrameBytes;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export class WebSocketSendGuard {
  private readonly states = new WeakMap<ServerWebSocket<unknown>, BackpressureState>();
  private readonly unavailable = new WeakSet<ServerWebSocket<unknown>>();
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

  canSend(ws: ServerWebSocket<unknown>): boolean {
    if (this.unavailable.has(ws)) {
      return false;
    }
    const state = this.states.get(ws);
    if (!state) {
      return true;
    }
    state.skippedFrame = true;
    return false;
  }

  sendFrames(ws: ServerWebSocket<unknown>, frames: readonly (string | BufferSource)[]): boolean {
    if (!this.canSend(ws)) {
      return false;
    }

    const maxFrameBytes = negotiatedFrameLimit(ws);
    if (
      maxFrameBytes !== null &&
      frames.some((frame) => frame !== undefined && frameByteLength(frame) > maxFrameBytes)
    ) {
      this.terminate(ws, 'oversized_frame');
      return false;
    }

    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index];
      if (frame === undefined) {
        continue;
      }

      let status: number | undefined;
      try {
        status = ws.send(frame as Parameters<ServerWebSocket<unknown>['send']>[0]);
      } catch {
        this.terminate(ws, 'dropped_frame');
        return false;
      }

      if (status === -1) {
        const state: BackpressureState = {
          skippedFrame: index + 1 < frames.length,
          timer: setTimeout(() => {
            if (this.states.get(ws) !== state) {
              return;
            }
            this.states.delete(ws);
            this.terminate(ws, 'backpressure_timeout');
          }, this.timeoutMs),
        };
        this.states.set(ws, state);
        return false;
      }

      if (status === 0) {
        this.terminate(ws, 'dropped_frame');
        return false;
      }
    }

    return true;
  }

  handleDrain(ws: ServerWebSocket<unknown>): void {
    const state = this.states.get(ws);
    if (!state) {
      return;
    }
    clearTimeout(state.timer);
    this.states.delete(ws);
    if (state.skippedFrame) {
      this.terminate(ws, 'backpressure_gap');
    }
  }

  markStreamGap(ws: ServerWebSocket<unknown>): void {
    const state = this.states.get(ws);
    if (state) {
      state.skippedFrame = true;
    }
  }

  forget(ws: ServerWebSocket<unknown>): void {
    const state = this.states.get(ws);
    if (state) {
      clearTimeout(state.timer);
      this.states.delete(ws);
    }
    this.unavailable.delete(ws);
  }

  snapshotStats(sockets: Iterable<ServerWebSocket<unknown>>): WebSocketSendGuardStats {
    let sessions = 0;
    let backpressuredSessions = 0;
    let unavailableSessions = 0;
    let queuedBytes = 0;
    for (const socket of sockets) {
      sessions += 1;
      if (this.states.has(socket)) backpressuredSessions += 1;
      if (this.unavailable.has(socket)) unavailableSessions += 1;
      try {
        queuedBytes += Math.max(0, socket.getBufferedAmount());
      } catch {
        // A concurrently closing socket contributes zero queued bytes.
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

  private terminate(ws: ServerWebSocket<unknown>, reason: TerminationReason): void {
    if (this.unavailable.has(ws)) {
      return;
    }
    this.unavailable.add(ws);
    this.terminationsByReason[reason] += 1;
    this.onTerminate(reason);
    try {
      ws.terminate();
    } catch {
      // The socket may already be closing.
    }
  }
}

export const gatewayWebSocketSendGuard = new WebSocketSendGuard();
