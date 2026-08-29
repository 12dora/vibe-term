import type { TerminalSizeSnapshot } from '../utils/resizeSyncGuards';

export type ResizeReportKind = 'resize' | 'sync';

export interface ResizeReportGate {
  sizingMode: 'report' | 'follow';
  deviceId: string;
  paneId: string;
  deviceConnected: boolean;
  isSelectionInvalid: boolean;
}

export interface ResizeReportInput {
  kind: ResizeReportKind;
  force: boolean;
  gate: ResizeReportGate;
  now: number;
  suppressUntil: number;
  hasTerminal: boolean;
  lastReportedSize: TerminalSizeSnapshot | null;
  measure: () => TerminalSizeSnapshot | null;
}

export type ResizeReportDecision =
  | { action: 'skip' }
  | { action: 'localOnly'; size: TerminalSizeSnapshot }
  | { action: 'report'; size: TerminalSizeSnapshot; callback: ResizeReportKind };

// follow 模式：pane 的 cols/rows 由 tmux layout 决定并经外部 resize() 显式设定，
// 容器像素测量（zoom 下有舍入误差）不可作为尺寸来源，也不上报
function isLinkReportable(gate: ResizeReportGate): boolean {
  return (
    gate.sizingMode === 'report' && Boolean(gate.deviceId && gate.paneId && gate.deviceConnected)
  );
}

function isBlocked({
  kind,
  force,
  gate,
  now,
  suppressUntil,
  hasTerminal,
}: ResizeReportInput): boolean {
  if (!isLinkReportable(gate)) return true;
  // sync 操作即使在 isSelectionInvalid 时也应该执行，因为尺寸同步是基础功能
  // isSelectionInvalid 主要影响用户输入，不应该阻止终端尺寸同步
  if (gate.isSelectionInvalid && kind !== 'sync') return true;
  if (!force && now < suppressUntil) return true;
  return !hasTerminal;
}

function isSameAsReported(input: ResizeReportInput, size: TerminalSizeSnapshot): boolean {
  const last = input.lastReportedSize;
  return !input.force && last !== null && last.cols === size.cols && last.rows === size.rows;
}

/**
 * 上报决策：skip 不测量也不改本地尺寸；localOnly 只把测量结果应用到本地终端；
 * report 才真正调用 onResize/onSync，并允许后续 onResizeSettled。
 */
export function decideResizeReport(input: ResizeReportInput): ResizeReportDecision {
  if (isBlocked(input)) return { action: 'skip' };
  const size = input.measure();
  if (!size) return { action: 'skip' };
  if (isSameAsReported(input, size)) return { action: 'localOnly', size };
  return { action: 'report', size, callback: input.kind };
}
