import type { PaneModeFlags } from '@vibeterm/shared';
import type { ControlModeBlock } from './control-mode-parser';
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

interface PendingControlCommand<T = unknown> {
  literal: boolean;
  onAck?: () => void;
  transform: (block: ControlModeBlock) => T;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  // 单调时钟起点；null 表示这条命令不参与宿主一跳延迟采样。
  sampleStartedAt: number | null;
  /** 已结算（非毒化超时）时留在队列里只为对齐后续 %end，不再 resolve/reject。 */
  settled: boolean;
  timeoutMs: number;
  /** `%begin` 已到时记下 command-number，超时拆成 orphan 后用来对块。 */
  seq?: number;
}

/** 非毒化超时拆掉的队头：tmux 仍可能晚到 `%end`，带截止时间；过期后只按 seq 丢弃，避免 FIFO 吞掉后续用户命令。 */
interface OrphanControlBlock {
  literal: boolean;
  deadline: number;
  seq?: number;
}

/** 过期 orphan 的 command-number 暂留，用来识别迟到块，避免把它 stamp 到下一条命令上。 */
const MAX_DISCARDED_ORPHAN_SEQS = 16;

export interface ControlCommandLatencyOptions {
  /** 上报一次 write→%end 往返毫秒数（仅限队列空闲时写出、正常收到 %end 的命令）。 */
  onSample: (rttMs: number) => void;
  now?: () => number;
}

function monotonicNow(): number {
  return performance.now();
}

export class ControlModeCommandQueue {
  private readonly pending: PendingControlCommand[] = [];
  private poisoned = false;
  private readonly orphans: OrphanControlBlock[] = [];
  private readonly discardedSeqs: number[] = [];
  private readonly clockNow: () => number;

  constructor(
    private readonly onPoison?: () => void,
    private readonly latency?: ControlCommandLatencyOptions
  ) {
    this.clockNow = latency?.now ?? monotonicNow;
  }

  /** 队列里还有未回执的命令：此时新命令的 %end 含前序命令的处理时间。 */
  get busy(): boolean {
    return this.pending.length > 0;
  }

  execute<T>(
    write: (command: string) => void,
    command: string,
    options: {
      literal?: boolean;
      timeoutMs?: number;
      onAck?: () => void;
      /** 参与宿主一跳延迟采样：只有廉价命令才应打开。 */
      sample?: boolean;
      /** 为 false 时只拒绝本命令，不毒化整条队列（空闲探针用）。默认 true。 */
      poisonOnTimeout?: boolean;
      transform: (block: ControlModeBlock) => T;
    }
  ): Promise<T> {
    if (this.poisoned) return Promise.reject(new Error('tmux control command queue is closed'));
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 10_000;
      const pending: PendingControlCommand<T> = {
        literal: options.literal ?? false,
        onAck: options.onAck,
        transform: options.transform,
        resolve,
        reject,
        sampleStartedAt: null,
        settled: false,
        timeoutMs,
        timer: setTimeout(() => {
          this.timeoutPending(
            pending as PendingControlCommand,
            new Error(`tmux control command timed out: ${command.slice(0, 80)}`),
            options.poisonOnTimeout !== false
          );
        }, timeoutMs),
      };
      const sampled = options.sample === true && this.latency !== undefined && !this.busy;
      this.pending.push(pending as PendingControlCommand);
      try {
        if (sampled) pending.sampleStartedAt = this.clockNow();
        write(command.endsWith('\n') ? command : `${command}\n`);
      } catch (error) {
        this.poison(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  nextBlockIsLiteral(args?: string): boolean {
    this.pruneExpiredOrphans();
    const seq = args === undefined ? undefined : parseCommandNumber(args);
    if (seq !== undefined && this.discardedSeqs.includes(seq)) return false;
    const orphan = this.orphanForBegin(seq);
    if (orphan) {
      stampSeq(orphan, seq);
      return orphan.literal;
    }
    const pending = this.pending[0];
    if (pending) stampSeq(pending, seq);
    return pending?.literal ?? false;
  }

  handleBlock(block: ControlModeBlock): boolean {
    if (this.consumeOrphan(block)) return true;
    if (this.swallowUnmatched(block)) return true;
    const pending = this.pending.shift();
    if (!pending) return false;
    clearTimeout(pending.timer);
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

  dispose(reason = 'tmux control command queue closed'): void {
    if (this.poisoned) return;
    this.poisoned = true;
    this.orphans.length = 0;
    this.discardedSeqs.length = 0;
    const error = new Error(reason);
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private reportLatency(pending: PendingControlCommand): void {
    if (pending.sampleStartedAt === null) return;
    this.latency?.onSample(this.clockNow() - pending.sampleStartedAt);
  }

  private timeoutPending(pending: PendingControlCommand, error: Error, poisonQueue: boolean): void {
    if (this.poisoned) return;
    if (poisonQueue) {
      this.poison(error);
      return;
    }
    const index = this.pending.indexOf(pending);
    if (index < 0) return;
    clearTimeout(pending.timer);
    pending.sampleStartedAt = null;
    pending.reject(error);
    if (index === 0) {
      this.pending.splice(index, 1);
      this.orphans.push({
        literal: pending.literal,
        deadline: monotonicNow() + pending.timeoutMs,
        seq: pending.seq,
      });
      return;
    }
    pending.settled = true;
  }

  private poison(error: Error): void {
    if (this.poisoned) return;
    this.poisoned = true;
    this.orphans.length = 0;
    this.discardedSeqs.length = 0;
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.onPoison?.();
  }

  private pruneExpiredOrphans(): void {
    const now = monotonicNow();
    while (this.orphans.length > 0) {
      const head = this.orphans[0];
      if (!head || head.deadline > now) break;
      this.orphans.shift();
      if (head.seq !== undefined) this.rememberDiscardedSeq(head.seq);
    }
  }

  /** 与 consumeOrphan 对齐：已知 seq 且对不上的 orphan 跳过，把 %begin 交给 pending。 */
  private orphanForBegin(seq: number | undefined): OrphanControlBlock | undefined {
    if (seq !== undefined) {
      const matched = this.orphans.find((orphan) => orphan.seq === seq);
      if (matched) return matched;
    }
    const head = this.orphans[0];
    if (!head) return undefined;
    if (seq !== undefined && head.seq !== undefined) return undefined;
    return head;
  }

  private rememberDiscardedSeq(seq: number): void {
    if (this.discardedSeqs.includes(seq)) return;
    this.discardedSeqs.push(seq);
    if (this.discardedSeqs.length > MAX_DISCARDED_ORPHAN_SEQS) this.discardedSeqs.shift();
  }

  private takeDiscardedSeq(seq: number): boolean {
    const index = this.discardedSeqs.indexOf(seq);
    if (index < 0) return false;
    this.discardedSeqs.splice(index, 1);
    return true;
  }

  /** 过期后迟到、对不上 pending 的块直接丢弃，避免落到下一条用户命令上。 */
  private swallowUnmatched(block: ControlModeBlock): boolean {
    const seq = parseCommandNumber(block.args);
    if (seq === undefined) return false;
    if (this.takeDiscardedSeq(seq)) return true;
    const pending = this.pending[0];
    return pending !== undefined && pending.seq !== undefined && pending.seq !== seq;
  }

  private consumeOrphan(block: ControlModeBlock): boolean {
    this.pruneExpiredOrphans();
    if (this.orphans.length === 0) return false;
    const seq = parseCommandNumber(block.args);
    const matched = seq === undefined ? -1 : this.orphans.findIndex((orphan) => orphan.seq === seq);
    if (matched >= 0) {
      this.orphans.splice(matched, 1);
      return true;
    }
    const head = this.orphans[0];
    if (seq !== undefined && head?.seq !== undefined) return false;
    this.orphans.shift();
    return true;
  }
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** `%begin/%end` 参数为 `time command-number flags`；缺字段时无法对号。 */
function parseCommandNumber(args: string): number | undefined {
  const firstSpace = args.indexOf(' ');
  if (firstSpace < 0) return undefined;
  const rest = args.slice(firstSpace + 1);
  const secondSpace = rest.indexOf(' ');
  const field = secondSpace < 0 ? rest : rest.slice(0, secondSpace);
  const parsed = parseNonNegativeInteger(field);
  return parsed === null ? undefined : parsed;
}

function stampSeq(target: { seq?: number }, seq: number | undefined): void {
  if (target.seq === undefined && seq !== undefined) target.seq = seq;
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
