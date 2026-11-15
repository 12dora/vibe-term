import type { ControlHealthSink } from './control-health';
import type { ControlModeBlock } from './control-mode-parser';
import type { ControlQueueClock, ControlStallProbe } from './control-stall-detector';

export interface PendingControlCommand<T = unknown> {
  label: string;
  literal: boolean;
  onAck?: () => void;
  transform: (block: ControlModeBlock) => T;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  // 单调时钟起点；null 表示这条命令不参与宿主一跳延迟采样。
  sampleStartedAt: number | null;
  /** 已结算（超时）时留在队列里只为对齐后续 %end，不再 resolve/reject。 */
  settled: boolean;
  timeoutMs: number;
  enqueuedAt: number;
  /** 成为队头（tmux 开始处理它）的时刻；单条超时从这里起算。 */
  headSince: number | null;
  /** 为 false（poisonOnTimeout:false）时不计入卡死判定。 */
  poisonOnStall: boolean;
  /** `%begin` 已到时记下 command-number，超时拆成 orphan 后用来对块。 */
  seq?: number;
}

export interface ControlCommandLatencyOptions {
  /** 上报一次 write→%end 往返毫秒数（仅限队列空闲时写出、正常收到 %end 的命令）。 */
  onSample: (rttMs: number) => void;
  now?: () => number;
}

export interface ControlQueueOptions {
  clock?: ControlQueueClock;
  /** 调用方未给 timeoutMs 时的单条超时（每次入队时读取，便于自适应）。 */
  defaultTimeoutMs?: () => number;
  stallTimeoutMs?: () => number;
  stallProbe?: ControlStallProbe;
  health?: ControlHealthSink;
}

export interface ControlCommandOptions<T> {
  literal?: boolean;
  timeoutMs?: number;
  onAck?: () => void;
  /** 参与宿主一跳延迟采样：只有廉价命令才应打开。 */
  sample?: boolean;
  /** 单条超时从不毒化队列；为 false 时这条命令也不计入卡死判定（探针、心跳用）。 */
  poisonOnTimeout?: boolean;
  transform: (block: ControlModeBlock) => T;
}

export function buildPendingCommand<T>(
  label: string,
  options: ControlCommandOptions<T>,
  resolve: (value: T) => void,
  reject: (error: Error) => void,
  timing: { timeoutMs: number; now: number }
): PendingControlCommand<T> {
  return {
    label,
    literal: options.literal ?? false,
    onAck: options.onAck,
    transform: options.transform,
    resolve,
    reject,
    sampleStartedAt: null,
    settled: false,
    timeoutMs: timing.timeoutMs,
    enqueuedAt: timing.now,
    headSince: null,
    poisonOnStall: options.poisonOnTimeout !== false,
  };
}
