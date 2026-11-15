import { CONTROL_STALL_MAX_EXTENSIONS } from './external/constants';

export interface ControlQueueClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export const systemControlQueueClock: ControlQueueClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** alive = tmux server 仍在跑（只是慢）；dead = 已停止/已退出；unknown = 无从判断。 */
export type ControlStallProbeResult = 'alive' | 'dead' | 'unknown';

export interface ControlStallProbe {
  /** 本条通道第一次出现命令超时时调用，给探针机会预先准备（如学 server pid）。 */
  prepare?(): void;
  check(): ControlStallProbeResult;
}

export type ControlStallVerdict = 'ok' | 'slow' | 'stalled';

/**
 * 卡死判定：自 max(最近一次控制流进展, backlog 起点, 上次宽限) 起整窗无进展才算卡死；
 * 探针确认进程仍在跑时最多宽限 CONTROL_STALL_MAX_EXTENSIONS 个窗口。
 */
export class ControlStallDetector {
  private activityAt: number;
  private backlogSince = Number.NEGATIVE_INFINITY;
  private extendedAt = Number.NEGATIVE_INFINITY;
  private extensions = 0;

  constructor(
    now: number,
    private readonly stallTimeoutMs: () => number,
    private readonly probe?: ControlStallProbe
  ) {
    this.activityAt = now;
  }

  get lastActivityAt(): number {
    return this.activityAt;
  }

  noteActivity(now: number): void {
    this.activityAt = now;
    this.extensions = 0;
  }

  noteBacklogStart(now: number): void {
    this.backlogSince = now;
    this.extensions = 0;
  }

  prepareProbe(): void {
    this.probe?.prepare?.();
  }

  nextCheckAt(since = Number.NEGATIVE_INFINITY): number {
    return this.anchor(since) + this.stallTimeoutMs();
  }

  assess(now: number, since = Number.NEGATIVE_INFINITY): ControlStallVerdict {
    if (now < this.nextCheckAt(since)) return 'ok';
    const state = this.probe?.check() ?? 'unknown';
    if (state === 'alive' && this.extensions < CONTROL_STALL_MAX_EXTENSIONS) {
      this.extensions += 1;
      this.extendedAt = now;
      return 'slow';
    }
    return 'stalled';
  }

  private anchor(since: number): number {
    return Math.max(this.activityAt, this.backlogSince, this.extendedAt, since);
  }
}
