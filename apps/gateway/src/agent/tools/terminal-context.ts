import type { PaneInfo } from '../../tmux-client/capture-history';
import type { PaneEmulator } from '../../tmux-client/pane-emulator';

export interface TerminalRuntimeLike {
  sendInput(paneId: string, data: string): void;
  capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string>;
  getPaneInfo(paneId: string): Promise<PaneInfo>;
  /** runtime 已终止（设备连接断开等）时为 true；用于主动停止 run 而非等工具超时 */
  readonly isTerminated?: boolean;
}

export interface CreateTerminalToolsOptions {
  paneId: string;
  /** pane 所属设备 id（查 snapshot 校验 pane 存在性 / 补元数据） */
  deviceId: string;
  getRuntime: () => TerminalRuntimeLike | null;
  /** 优先数据源：该 pane 的 headless 模拟器（渲染态 + 流）。null 则退回 capture-pane。 */
  getEmulator?: () => PaneEmulator | null;
  /** runtime 已终止的主动校验（设备连接断开）；返回 true 视为连接可用 */
  isRuntimeAlive?: () => boolean;
  /** 允许 send_input 写入原始控制字符（rawControlChars 字段）；默认 false（忽略并提示） */
  allowControlChars?: boolean;
  needsApprovalForWrite: boolean;
  onFailure: () => void;
  onSuccess: () => void;
  sleepMs?: (ms: number) => Promise<void>;
}

export interface TerminalToolError {
  error: string;
}

/** 只读工具上下文：builder 共享，不含可变 run 状态。 */
export interface TerminalToolContext {
  readonly paneId: string;
  readonly deviceId: string;
  readonly allowControlChars: boolean;
  readonly needsApprovalForWrite: boolean;
  readonly getRuntime: () => TerminalRuntimeLike | null;
  readonly getEmulator: () => PaneEmulator | null;
  readonly isRuntimeAlive: () => boolean;
  readonly onFailure: () => void;
  readonly onSuccess: () => void;
  readonly sleepMs: (ms: number) => Promise<void>;
}

export function toToolErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTerminalToolContext(
  options: CreateTerminalToolsOptions
): TerminalToolContext {
  return {
    paneId: options.paneId,
    deviceId: options.deviceId,
    allowControlChars: options.allowControlChars ?? false,
    needsApprovalForWrite: options.needsApprovalForWrite,
    getRuntime: options.getRuntime,
    getEmulator: options.getEmulator ?? (() => null),
    isRuntimeAlive: options.isRuntimeAlive ?? (() => true),
    onFailure: options.onFailure,
    onSuccess: options.onSuccess,
    sleepMs: options.sleepMs ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

export function failTool(ctx: TerminalToolContext, message: string): TerminalToolError {
  ctx.onFailure();
  return { error: message };
}

export function checkRuntimeAlive(ctx: TerminalToolContext): TerminalToolError | null {
  if (!ctx.isRuntimeAlive()) {
    return failTool(ctx, 'Terminal connection is no longer available.');
  }
  return null;
}

/** emulator 可用且未 dispose 时返回，否则 null（调用方走 capture 回退）。 */
export function liveEmulator(ctx: TerminalToolContext): PaneEmulator | null {
  const emulator = ctx.getEmulator();
  if (emulator && !emulator.isDisposed) {
    return emulator;
  }
  return null;
}
