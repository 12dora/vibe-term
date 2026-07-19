import type { ServerWebSocket } from 'bun';

export const GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES = 1_048_576;
export const GATEWAY_WS_BACKPRESSURE_TIMEOUT_MS = 5_000;

interface BackpressureState {
  skippedFrame: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface WebSocketSendGuardOptions {
  timeoutMs?: number;
  onTerminate?: (reason: 'backpressure_gap' | 'backpressure_timeout' | 'dropped_frame') => void;
}

export class WebSocketSendGuard {
  private readonly states = new WeakMap<ServerWebSocket<unknown>, BackpressureState>();
  private readonly unavailable = new WeakSet<ServerWebSocket<unknown>>();
  private readonly timeoutMs: number;
  private readonly onTerminate: NonNullable<WebSocketSendGuardOptions['onTerminate']>;

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

    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index];
      if (frame === undefined) {
        continue;
      }

      let status: number | undefined;
      try {
        status = ws.send(frame);
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

  private terminate(
    ws: ServerWebSocket<unknown>,
    reason: 'backpressure_gap' | 'backpressure_timeout' | 'dropped_frame'
  ): void {
    if (this.unavailable.has(ws)) {
      return;
    }
    this.unavailable.add(ws);
    this.onTerminate(reason);
    try {
      ws.terminate();
    } catch {
      // The socket may already be closing.
    }
  }
}

export const gatewayWebSocketSendGuard = new WebSocketSendGuard();
