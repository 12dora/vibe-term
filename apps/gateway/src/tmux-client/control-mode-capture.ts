import type { PaneModeFlags } from '@vibeterm/shared';
import { logAt } from '../log/level';
import type { ControlHealthInfo, ControlHealthSink } from './control-health';
import type { ControlModeBlock } from './control-mode-parser';
import {
  ControlOrphanBook,
  parseCommandNumber,
  parseNonNegativeInteger,
  stampSeq,
} from './control-orphan-book';
import {
  type ControlCommandLatencyOptions,
  type ControlCommandOptions,
  type ControlQueueOptions,
  type PendingControlCommand,
  buildPendingCommand,
} from './control-queue-types';
import {
  type ControlQueueClock,
  ControlStallDetector,
  type ControlStallVerdict,
  systemControlQueueClock,
} from './control-stall-detector';
import {
  CONTROL_COMMAND_HARD_TIMEOUT_FACTOR,
  CONTROL_COMMAND_TIMEOUT_MS,
  CONTROL_STALL_TIMEOUT_MS,
} from './external/constants';
import { isTmuxPaneId } from './snapshot-format';

export interface AtomicPaneCapture {
  // 可见区（-S 0 起）；历史段单独采集，避免 -J 把跨越 history/可见区边界的
  // 折行合并成一行导致可见区行数漂移、绝对光标恢复错位。
  text: string;
  // 纯历史段（-S -N -E -1）；未请求历史时为 null。alt 屏或 history_size=0 时
  // tmux 会退化返回可见区首行，消费方必须结合同屏障的 alternate_on/history_size 门控。
  historyText: string | null;
  cols: number;
  rows: number;
  cursorX: number | null;
  cursorY: number | null;
  alternateScreen: boolean;
  historySize: number;
  // capture-pane 文本不含 DECSET 序列，鼠标模式唯一权威来源是 tmux 的 format 变量，
  // 必须与截屏在同一 control 屏障内读取；null 表示该连接采不到（快照将不声明模式位图）。
  modes: PaneModeFlags | null;
}

export type {
  ControlCommandLatencyOptions,
  ControlCommandOptions,
  ControlQueueOptions,
} from './control-queue-types';
export const CONTROL_QUEUE_MAX_DEPTH = 512;
const FULL_WARN_INTERVAL_MS = 5_000;

export class ControlQueueFullError extends Error {
  readonly code = 'control_queue_full' as const;
  constructor() {
    super('control_queue_full');
    this.name = 'ControlQueueFullError';
  }
}

function monotonicNow(): number {
  return performance.now();
}

export class ControlModeCommandQueue {
  private readonly pending: PendingControlCommand[] = [];
  private poisoned = false;
  private readonly orphans = new ControlOrphanBook();
  private readonly latencyNow: () => number;
  private readonly clock: ControlQueueClock;
  private readonly stall: ControlStallDetector;
  private readonly defaultTimeoutMs: () => number;
  private readonly health?: ControlHealthSink;
  private timer: unknown = null;
  private timerAt = Number.POSITIVE_INFINITY;
  private probePrepared = false;
  /** 过期丢弃的 orphan 一直没等到回执：仍算有命令在途，卡死判定不能因此失明。 */
  private unanswered = false;
  private lastFullWarnAt = 0;

  constructor(
    private readonly onPoison?: () => void,
    private readonly latency?: ControlCommandLatencyOptions,
    options: ControlQueueOptions = {}
  ) {
    this.latencyNow = latency?.now ?? monotonicNow;
    this.clock = options.clock ?? systemControlQueueClock;
    this.stall = new ControlStallDetector(
      this.clock.now(),
      options.stallTimeoutMs ?? (() => CONTROL_STALL_TIMEOUT_MS),
      options.stallProbe
    );
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? (() => CONTROL_COMMAND_TIMEOUT_MS);
    this.health = options.health;
  }

  /** 队列里还有未回执的命令：此时新命令的 %end 含前序命令的处理时间。 */
  get busy(): boolean {
    return this.pending.length > 0;
  }

  /** 最近一次控制流进展（任何 stdout 字节 / 命令块）的单调时刻。 */
  get lastActivityAt(): number {
    return this.stall.lastActivityAt;
  }

  now(): number {
    return this.clock.now();
  }

  idleMs(): number {
    return this.clock.now() - this.stall.lastActivityAt;
  }

  noteActivity(): void {
    const now = this.clock.now();
    this.stall.noteActivity(now);
    if (!this.hasBacklog()) this.reportRecovered(now);
  }

  execute<T>(
    write: (command: string) => void,
    command: string,
    options: ControlCommandOptions<T>
  ): Promise<T> {
    if (this.poisoned) return Promise.reject(new Error('tmux control command queue is closed'));
    if (this.pending.length >= CONTROL_QUEUE_MAX_DEPTH) {
      this.warnFull();
      return Promise.reject(new ControlQueueFullError());
    }
    return new Promise<T>((resolve, reject) => {
      const sampled = options.sample === true && this.latency !== undefined && !this.busy;
      const pending = this.enqueue(
        buildPendingCommand(command.slice(0, 80), options, resolve, reject, {
          timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs(),
          now: this.clock.now(),
        })
      );
      this.armTimer();
      try {
        if (sampled) pending.sampleStartedAt = this.latencyNow();
        write(command.endsWith('\n') ? command : `${command}\n`);
      } catch (error) {
        this.poison(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * 占住 `attach-session` 自己的首个 `%begin/%end`：attach 就绪前入队的命令排在它后面，
   * 不会认领它的空块。不写 stdin、不计时、不计入卡死判定。
   */
  expectAttach(): Promise<void> {
    if (this.poisoned) return Promise.reject(new Error('tmux control command queue is closed'));
    return new Promise<void>((resolve, reject) => {
      const options = { poisonOnTimeout: false, transform: () => undefined };
      this.enqueue(
        buildPendingCommand('attach-session', options, resolve, reject, {
          timeoutMs: Number.POSITIVE_INFINITY,
          now: this.clock.now(),
        })
      );
    });
  }

  private enqueue<T>(pending: PendingControlCommand<T>): PendingControlCommand<T> {
    if (!this.hasBacklog()) this.stall.noteBacklogStart(pending.enqueuedAt);
    this.pending.push(pending as PendingControlCommand);
    this.promoteHead(pending.enqueuedAt);
    return pending;
  }

  nextBlockIsLiteral(args?: string): boolean {
    this.pruneExpiredOrphans(this.clock.now());
    const seq = args === undefined ? undefined : parseCommandNumber(args);
    const orphanLiteral = this.orphans.literalForBegin(seq);
    if (orphanLiteral !== undefined) return orphanLiteral;
    const pending = this.pending[0];
    if (pending) stampSeq(pending, seq);
    return pending?.literal ?? false;
  }

  handleBlock(block: ControlModeBlock): boolean {
    const now = this.clock.now();
    this.stall.noteActivity(now);
    this.unanswered = false;
    this.pruneExpiredOrphans(now);
    if (this.orphans.consume(parseCommandNumber(block.args))) {
      this.afterProgress(now, false);
      return true;
    }
    if (this.swallowUnmatched(block)) return true;
    const pending = this.pending.shift();
    if (!pending) return false;
    this.afterProgress(now, !pending.settled);
    if (pending.settled) return true;
    if (!block.isError) this.reportLatency(pending);
    if (block.isError) {
      pending.reject(new Error(block.lines.join('\n') || 'tmux control command failed'));
      return true;
    }
    try {
      const value = pending.transform(block);
      pending.onAck?.();
      pending.resolve(value);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }

  /** 心跳用：自 since 起整窗无控制流进展（含本机进程存活宽限）才判 stalled。 */
  assessStall(since: number): ControlStallVerdict {
    const now = this.clock.now();
    const verdict = this.stall.assess(now, since);
    if (verdict === 'slow') this.reportSlow(now);
    return verdict;
  }

  poisonStalled(): void {
    if (this.poisoned) return;
    const info = this.healthInfo(this.clock.now());
    this.health?.report('stalled', info);
    this.poison(
      new Error(`tmux control channel stalled: no progress for ${info.lastActivityAgoMs}ms`)
    );
  }

  private warnFull(): void {
    const now = Date.now();
    if (now - this.lastFullWarnAt < FULL_WARN_INTERVAL_MS) return;
    this.lastFullWarnAt = now;
    logAt('warn', `[tmux] control_queue_full pending=${this.pending.length}`);
  }

  dispose(reason = 'tmux control command queue closed'): void {
    if (this.poisoned) return;
    this.close(new Error(reason));
  }

  private close(error: Error): void {
    this.poisoned = true;
    this.cancelTimer();
    this.orphans.clear();
    for (const pending of this.pending.splice(0)) {
      if (!pending.settled) pending.reject(error);
    }
  }

  private poison(error: Error): void {
    if (this.poisoned) return;
    this.close(error);
    this.onPoison?.();
  }

  private hasBacklog(): boolean {
    return this.unanswered || this.pending.length > 0 || this.orphans.size > 0;
  }

  /** orphan 未清时 tmux 仍在处理旧队头，下一条的单条计时要等它回执或过期才开始。 */
  private promoteHead(now: number): void {
    if (this.orphans.size > 0) return;
    const head = this.pending[0];
    if (head && head.headSince === null) head.headSince = now;
  }

  private afterProgress(now: number, answered: boolean): void {
    this.promoteHead(now);
    if (answered || !this.hasBacklog()) this.reportRecovered(now);
    this.armTimer();
  }

  private deadlineOf(pending: PendingControlCommand): number {
    const head =
      pending.headSince === null ? Number.POSITIVE_INFINITY : pending.headSince + pending.timeoutMs;
    if (pending.settled) return head;
    return Math.min(
      head,
      pending.enqueuedAt + pending.timeoutMs * CONTROL_COMMAND_HARD_TIMEOUT_FACTOR
    );
  }

  private nextDeadline(): number {
    let at = Number.POSITIVE_INFINITY;
    for (const pending of this.pending) at = Math.min(at, this.deadlineOf(pending));
    at = Math.min(at, this.orphans.earliestDeadline());
    if (this.hasStallCandidates()) at = Math.min(at, this.stall.nextCheckAt());
    return at;
  }

  /** 只在新截止时间更早时重排定时器；提前醒来由 onTimer 重新计算。 */
  private armTimer(): void {
    if (this.poisoned) return;
    const at = this.nextDeadline();
    if (this.timer !== null && this.timerAt <= at) return;
    this.cancelTimer();
    if (!Number.isFinite(at)) return;
    this.timerAt = at;
    this.timer = this.clock.setTimeout(
      () => {
        this.timer = null;
        this.timerAt = Number.POSITIVE_INFINITY;
        this.onTimer();
      },
      Math.max(0, at - this.clock.now())
    );
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = Number.POSITIVE_INFINITY;
  }

  private onTimer(): void {
    if (this.poisoned) return;
    const now = this.clock.now();
    this.pruneExpiredOrphans(now);
    for (const pending of [...this.pending]) {
      if (this.deadlineOf(pending) <= now) this.expire(pending, now);
    }
    if (this.checkStall(now)) return;
    this.armTimer();
  }

  private expire(pending: PendingControlCommand, now: number): void {
    if (!pending.settled) {
      pending.settled = true;
      pending.sampleStartedAt = null;
      pending.reject(new Error(`tmux control command timed out: ${pending.label}`));
      if (!this.probePrepared) {
        this.probePrepared = true;
        this.stall.prepareProbe();
      }
      this.reportSlow(now);
    }
    if (pending.headSince === null || this.pending[0] !== pending) return;
    this.pending.shift();
    this.orphans.add({
      literal: pending.literal,
      deadline: now + pending.timeoutMs,
      headSince: pending.headSince,
      poisonOnStall: pending.poisonOnStall,
      seq: pending.seq,
    });
  }

  private hasStallCandidates(): boolean {
    return (
      this.unanswered ||
      this.pending.some((pending) => pending.poisonOnStall) ||
      this.orphans.hasStallCandidate()
    );
  }

  private checkStall(now: number): boolean {
    if (!this.hasStallCandidates()) return false;
    const verdict = this.stall.assess(now);
    if (verdict === 'ok') return false;
    if (verdict === 'slow') {
      this.reportSlow(now);
      return false;
    }
    this.poisonStalled();
    return true;
  }

  private healthInfo(now: number): ControlHealthInfo {
    const head = this.orphans.head?.headSince ?? this.pending[0]?.headSince ?? now;
    return {
      headAgeMs: Math.max(0, Math.round(now - head)),
      lastActivityAgoMs: Math.max(0, Math.round(now - this.stall.lastActivityAt)),
    };
  }

  private reportSlow(now: number): void {
    this.health?.report('slow', this.healthInfo(now));
  }

  private reportRecovered(now: number): void {
    if (this.health?.degraded) this.health.report('recovered', this.healthInfo(now));
  }

  private reportLatency(pending: PendingControlCommand): void {
    if (pending.sampleStartedAt === null) return;
    this.latency?.onSample(this.latencyNow() - pending.sampleStartedAt);
  }

  private pruneExpiredOrphans(now: number): void {
    if (this.orphans.prune(now)) this.unanswered = true;
    this.promoteHead(now);
  }

  /** 过期后迟到、对不上 pending 的块直接丢弃，避免落到下一条用户命令上。 */
  private swallowUnmatched(block: ControlModeBlock): boolean {
    const seq = parseCommandNumber(block.args);
    if (seq === undefined) return false;
    if (this.orphans.takeDiscardedSeq(seq)) return true;
    const pending = this.pending[0];
    return pending !== undefined && pending.seq !== undefined && pending.seq !== seq;
  }
}

function parsePaneFrameInfo(
  block: ControlModeBlock
): Omit<AtomicPaneCapture, 'text' | 'historyText'> {
  const info = block.lines[0]?.split('|');
  const cols = parseNonNegativeInteger(info?.[0]);
  const rows = parseNonNegativeInteger(info?.[1]);
  if (cols === null || rows === null || cols < 1 || rows < 1) {
    throw new Error('invalid tmux pane frame info');
  }
  return {
    cols,
    rows,
    alternateScreen: info?.[2] === '1',
    cursorX: parseNonNegativeInteger(info?.[3]),
    cursorY: parseNonNegativeInteger(info?.[4]),
    historySize: parseNonNegativeInteger(info?.[5]) ?? 0,
    modes: {
      mouseStandard: info?.[6] === '1',
      mouseButton: info?.[7] === '1',
      mouseAll: info?.[8] === '1',
      mouseSgr: info?.[9] === '1',
      mouseUtf8: info?.[10] === '1',
    },
  };
}

// capture-pane 未加 -C 时返回原始文本，不能按 %output 的八进制规则解码。
export function capturedBlockText(block: ControlModeBlock): string {
  return block.lines.join('\n');
}

export const MAX_PANE_HISTORY_LINES = 4096;
export const MAX_PANE_HISTORY_CAPTURE_BYTES = 4 * 1024 * 1024;

export async function capturePaneFrameAtControlBarrier(
  queue: ControlModeCommandQueue,
  write: (command: string) => void,
  paneId: string,
  historyLines: number,
  onBarrier: () => void,
  timeoutMs = 10_000
): Promise<AtomicPaneCapture> {
  if (!isTmuxPaneId(paneId)) throw new Error(`invalid tmux pane id: ${paneId}`);
  const boundedHistoryLines = Math.max(
    0,
    Math.min(MAX_PANE_HISTORY_LINES, Math.floor(historyLines))
  );
  const infoPromise = queue.execute(
    write,
    `display-message -p -t ${paneId} "#{pane_width}|#{pane_height}|#{alternate_on}|#{cursor_x}|#{cursor_y}|#{history_size}|#{mouse_standard_flag}|#{mouse_button_flag}|#{mouse_all_flag}|#{mouse_sgr_flag}|#{mouse_utf8_flag}"`,
    {
      timeoutMs,
      transform: parsePaneFrameInfo,
    }
  );
  const visibleArgs = ['capture-pane', '-p', '-e', '-J', '-N', '-t', paneId];
  const textPromise = queue.execute(write, visibleArgs.join(' '), {
    literal: true,
    timeoutMs,
    transform: (block) => {
      onBarrier();
      // 不补行尾换行：整屏快照写进终端时，末行多一个换行会把首行顶出屏幕，
      // 随后按绝对坐标恢复的光标就会落在错位一行的内容上。
      return capturedBlockText(block);
    },
  });
  const historyPromise =
    boundedHistoryLines > 0
      ? queue.execute(
          write,
          [...visibleArgs, '-S', `-${boundedHistoryLines}`, '-E', '-1'].join(' '),
          {
            literal: true,
            timeoutMs,
            transform: capturedBlockText,
          }
        )
      : Promise.resolve(null);
  const [info, text, historyText] = await Promise.all([infoPromise, textPromise, historyPromise]);
  return { ...info, text, historyText };
}
