import { MouseReportingScanner } from './mouse-reporting-scanner';
import { type MouseSequence, splitMouseSequences } from './mouse-sequence';

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

interface InputEntry {
  bytes: Uint8Array;
  mouse: MouseSequence | null;
  generation: number;
  resolve(): void;
  reject(error: unknown): void;
}

interface PaneLane {
  pending: InputEntry[];
  active: InputEntry | null;
  lastMotion: InputEntry | null;
  generation: number;
  reporting: MouseReportingScanner;
  responseMs: number;
  writtenAt: number | null;
  outputSeen: boolean;
  lastOutputAt: number;
  fallbackMs: number;
  timer: unknown;
  timerAt: number | null;
  dropped: number;
  lastDropLogAt: number;
}

/** 回执后至少隔这么久才写下一条鼠标序列 */
const MIN_SPACING_MS = 8;
/** 输出静默这么久才认为应用已消费上一条 */
const OUTPUT_QUIET_MS = 3;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class PaneInputPacer {
  private readonly panes = new Map<string, PaneLane>();
  private disposed = false;
  private transportReady = true;
  private generation = 0;

  constructor(
    private readonly write: (
      paneId: string,
      bytes: Uint8Array,
      onAck: () => void
    ) => void | Promise<void>,
    private readonly clock: InputLaneClock = systemClock,
    private readonly warn: (message: string) => void = console.warn,
    private readonly onError: (error: unknown) => void = (error) =>
      console.error('[tmux][input-lane] write failed:', error)
  ) {}

  sendInputBytes(paneId: string, bytes: Uint8Array): Promise<void> {
    if (this.disposed || !this.transportReady) {
      const rejected = Promise.reject<void>(new Error('tmux input transport unavailable'));
      void rejected.catch(() => {});
      return rejected;
    }
    const lane = this.getLane(paneId);
    const sequences = splitMouseSequences(bytes);
    const completions = (sequences ?? [null]).map(
      (mouse) =>
        new Promise<void>((resolve, reject) => {
          const entry = {
            bytes: mouse?.bytes ?? bytes.slice(),
            mouse,
            generation: this.generation,
            resolve,
            reject,
          };
          this.enqueue(paneId, lane, entry);
        })
    );
    const result = Promise.all(completions).then(() => undefined);
    void result.catch(() => {});
    return result;
  }

  onOutput(paneId: string, bytes: Uint8Array): void {
    if (this.disposed || !this.transportReady || bytes.byteLength === 0) return;
    const lane = this.getLane(paneId);
    if (lane.reporting.push(bytes)) {
      this.discardMouse(lane);
      this.pump(paneId, lane);
      return;
    }
    if (lane.active?.mouse || lane.writtenAt === null) return;
    // 一帧输出可能拆成多段 %output 到达：把「静默 OUTPUT_QUIET_MS」当作应用已消费上一条的
    // 依据，否则上一帧的尾段会被当成本条的响应，下一条提前落进 pty 与本条合并读取。
    const now = this.clock.now();
    lane.lastOutputAt = now;
    if (!lane.outputSeen) {
      lane.outputSeen = true;
      const sample = Math.max(1, now - lane.writtenAt);
      lane.responseMs += 0.25 * (sample - lane.responseMs);
    }
    this.pump(paneId, lane);
  }

  invalidateTransport(): void {
    this.transportReady = false;
    this.generation += 1;
    this.clear();
  }

  readyTransport(): void {
    this.transportReady = true;
  }

  dropPane(paneId: string): void {
    const lane = this.panes.get(paneId);
    if (!lane) return;
    this.clearTimer(lane);
    this.panes.delete(paneId);
    const error = new Error('tmux input lane cancelled');
    lane.active?.reject(error);
    for (const entry of lane.pending) entry.reject(error);
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
        active: null,
        lastMotion: null,
        generation: this.generation,
        reporting: new MouseReportingScanner(),
        responseMs: 15,
        writtenAt: null,
        outputSeen: false,
        lastOutputAt: 0,
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

  private enqueue(paneId: string, lane: PaneLane, entry: InputEntry): void {
    if (!this.isCurrent(paneId, lane)) {
      entry.reject(new Error('tmux input transport changed'));
      return;
    }
    const previous = lane.pending.at(-1);
    const motion = entry.mouse?.motionKey;
    if (motion && previous === lane.lastMotion && previous?.mouse?.motionKey === motion) {
      lane.pending.pop();
      previous.resolve();
    }
    const kind = motion ? 'motionKey' : 'droppable';
    const count = lane.pending.filter((pending) => pending.mouse?.[kind]).length;
    const maxPending = clamp(Math.round(300 / lane.responseMs), 3, 64);
    if ((motion || entry.mouse?.droppable) && count >= maxPending) {
      lane.lastMotion = null;
      this.noteDrop(paneId, lane);
      entry.resolve();
      return;
    }
    lane.lastMotion = motion ? entry : null;
    lane.pending.push(entry);
    this.pump(paneId, lane);
  }

  private discardMouse(lane: PaneLane): void {
    this.clearTimer(lane);
    lane.lastMotion = null;
    lane.pending = lane.pending.filter((entry) => {
      if (!entry.mouse) return true;
      entry.resolve();
      return false;
    });
    lane.writtenAt = null;
    lane.outputSeen = false;
  }

  private pump(paneId: string, lane: PaneLane): void {
    if (lane.pending.length === 0 || lane.active || !this.isCurrent(paneId, lane)) return;
    const now = this.clock.now();
    const readyAt =
      !lane.pending[0].mouse || lane.writtenAt === null ? now : this.mouseReadyAt(lane);
    if (now < readyAt) {
      this.schedule(paneId, lane, readyAt);
      return;
    }
    this.clearTimer(lane);
    const entry = lane.pending.shift();
    if (!entry || entry.generation !== this.generation) return;
    lane.active = entry;
    if (entry.mouse) lane.outputSeen = false;
    this.writeEntry(paneId, lane, entry);
  }

  private mouseReadyAt(lane: PaneLane): number {
    const writtenAt = lane.writtenAt ?? 0;
    if (!lane.outputSeen) return writtenAt + lane.fallbackMs;
    return Math.min(
      writtenAt + lane.fallbackMs,
      Math.max(writtenAt + MIN_SPACING_MS, lane.lastOutputAt + OUTPUT_QUIET_MS)
    );
  }

  private writeEntry(paneId: string, lane: PaneLane, entry: InputEntry): void {
    let acknowledged = false;
    const ack = () => {
      if (acknowledged || !this.isCurrent(paneId, lane) || lane.active !== entry) return;
      acknowledged = true;
      lane.active = null;
      // 同一 stdout chunk 中 %end 后的输出必须同步看到 ack；间隔也从此刻起算。
      if (entry.mouse) {
        lane.writtenAt = this.clock.now();
        lane.fallbackMs = clamp(4 * lane.responseMs, 40, 250);
      }
      entry.resolve();
      this.pump(paneId, lane);
    };
    const fail = (error: unknown) => {
      entry.reject(error);
      if (!this.isCurrent(paneId, lane)) return;
      this.dropPane(paneId);
      this.onError(error);
    };
    try {
      const result = this.write(paneId, entry.bytes, ack);
      if (result) void result.then(ack, fail);
      else ack();
    } catch (error) {
      fail(error);
    }
  }

  private isCurrent(paneId: string, lane: PaneLane): boolean {
    return (
      this.transportReady && lane.generation === this.generation && this.panes.get(paneId) === lane
    );
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
