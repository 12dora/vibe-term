import { splitMouseSequences } from './mouse-sequence';

export interface InputLaneClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

const systemClock: InputLaneClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

interface PaneLane {
  pending: Uint8Array[];
  responseMs: number;
  writtenAt: number | null;
  outputSeen: boolean;
  fallbackMs: number;
  timer: unknown;
  timerAt: number | null;
  dropped: number;
  lastDropLogAt: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class PaneInputPacer {
  private readonly panes = new Map<string, PaneLane>();
  private disposed = false;

  constructor(
    private readonly write: (paneId: string, bytes: Uint8Array) => void | Promise<void>,
    private readonly clock: InputLaneClock = systemClock,
    private readonly warn: (message: string) => void = console.warn,
    private readonly onError: (error: unknown) => void = (error) =>
      console.error('[tmux][input-lane] write failed:', error)
  ) {}

  sendInputBytes(paneId: string, bytes: Uint8Array): void {
    if (this.disposed) return;
    const sequences = splitMouseSequences(bytes);
    if (!sequences) {
      this.drain(paneId);
      this.writeBytes(paneId, bytes);
      return;
    }
    const lane = this.getLane(paneId);
    for (const sequence of sequences) {
      const maxPending = clamp(Math.round(300 / lane.responseMs), 3, 64);
      if (sequence.droppable && lane.pending.length >= maxPending) {
        this.noteDrop(paneId, lane);
        continue;
      }
      lane.pending.push(sequence.bytes);
      this.pump(paneId, lane);
    }
  }

  onOutput(paneId: string, bytes: Uint8Array): void {
    const lane = this.panes.get(paneId);
    if (!lane || bytes.byteLength === 0 || lane.writtenAt === null || lane.outputSeen) return;
    lane.outputSeen = true;
    const sample = Math.max(1, this.clock.now() - lane.writtenAt);
    lane.responseMs += 0.25 * (sample - lane.responseMs);
    this.pump(paneId, lane);
  }

  drain(paneId: string): void {
    const lane = this.panes.get(paneId);
    if (!lane || lane.pending.length === 0) return;
    this.clearTimer(lane);
    // 普通输入是顺序屏障：逐条提交鼠标字节，再交给连接原有的输入队列。
    const pending = lane.pending.splice(0);
    for (const bytes of pending) this.writeBytes(paneId, bytes);
    lane.writtenAt = this.clock.now();
    lane.outputSeen = false;
    lane.fallbackMs = clamp(4 * lane.responseMs, 40, 250);
  }

  dropPane(paneId: string): void {
    const lane = this.panes.get(paneId);
    if (!lane) return;
    this.clearTimer(lane);
    this.panes.delete(paneId);
  }

  retainPanes(keep: (paneId: string) => boolean): void {
    for (const paneId of this.panes.keys()) {
      if (!keep(paneId)) this.dropPane(paneId);
    }
  }

  clear(): void {
    for (const paneId of this.panes.keys()) this.dropPane(paneId);
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private getLane(paneId: string): PaneLane {
    let lane = this.panes.get(paneId);
    if (!lane) {
      lane = {
        pending: [],
        responseMs: 15,
        writtenAt: null,
        outputSeen: false,
        fallbackMs: 60,
        timer: null,
        timerAt: null,
        dropped: 0,
        lastDropLogAt: Number.NEGATIVE_INFINITY,
      };
      this.panes.set(paneId, lane);
    }
    return lane;
  }

  private pump(paneId: string, lane: PaneLane): void {
    if (lane.pending.length === 0) return;
    const now = this.clock.now();
    const readyAt =
      lane.writtenAt === null ? now : lane.writtenAt + (lane.outputSeen ? 8 : lane.fallbackMs);
    if (now < readyAt) {
      this.schedule(paneId, lane, readyAt);
      return;
    }
    this.clearTimer(lane);
    const bytes = lane.pending.shift();
    if (!bytes) return;
    lane.writtenAt = now;
    lane.outputSeen = false;
    lane.fallbackMs = clamp(4 * lane.responseMs, 40, 250);
    this.writeBytes(paneId, bytes);
    if (this.panes.get(paneId) === lane) this.schedulePending(paneId, lane);
  }

  private schedulePending(paneId: string, lane: PaneLane): void {
    if (lane.pending.length === 0 || lane.timer !== null) return;
    const delay = lane.outputSeen ? 8 : lane.fallbackMs;
    this.schedule(paneId, lane, (lane.writtenAt ?? this.clock.now()) + delay);
  }

  private schedule(paneId: string, lane: PaneLane, readyAt: number): void {
    if (lane.timerAt === readyAt) return;
    this.clearTimer(lane);
    lane.timerAt = readyAt;
    lane.timer = this.clock.setTimeout(
      () => {
        lane.timer = null;
        lane.timerAt = null;
        this.pump(paneId, lane);
      },
      Math.max(0, readyAt - this.clock.now())
    );
  }

  private clearTimer(lane: PaneLane): void {
    if (lane.timer === null) return;
    this.clock.clearTimeout(lane.timer);
    lane.timer = null;
    lane.timerAt = null;
  }

  private writeBytes(paneId: string, bytes: Uint8Array): void {
    try {
      const result = this.write(paneId, bytes);
      if (result) void result.catch(this.onError);
    } catch (error) {
      this.onError(error);
    }
  }

  private noteDrop(paneId: string, lane: PaneLane): void {
    lane.dropped += 1;
    const now = this.clock.now();
    if (now - lane.lastDropLogAt < 5_000) return;
    lane.lastDropLogAt = now;
    this.warn(
      `[tmux][input-lane] pane=${paneId} dropped=${lane.dropped} pending=${lane.pending.length} response_ms=${Math.round(lane.responseMs)}`
    );
  }
}
