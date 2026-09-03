// 一次 select-pane 的下发：归一化尺寸后发命令。
// 从 tmux-selection-actions 的工厂里拆出来，保持那边只做状态面与生命周期编排。

import { generateSelectToken } from '@tmex/ws-client';
import type { RuntimeCore } from './runtime';

export interface SelectPaneRequest {
  deviceId: string;
  windowId: string;
  paneId: string;
  size?: { cols?: number; rows?: number };
}

export interface SelectPaneDispatchDeps {
  core: RuntimeCore;
  /** 本次没带尺寸时的回落：该设备最近一次上报的终端尺寸 */
  fallbackSize(deviceId: string): { cols: number; rows: number } | null;
}

export function normalizeTerminalSize(
  cols: number | undefined,
  rows: number | undefined
): { cols: number; rows: number } | null {
  if (typeof cols !== 'number' || typeof rows !== 'number') {
    return null;
  }

  const safeCols = Math.max(2, Math.floor(cols));
  const safeRows = Math.max(2, Math.floor(rows));
  return { cols: safeCols, rows: safeRows };
}

export function dispatchSelectPane(
  { core, fallbackSize }: SelectPaneDispatchDeps,
  { deviceId, windowId, paneId, size }: SelectPaneRequest
): void {
  const normalizedSize = normalizeTerminalSize(size?.cols, size?.rows) ?? fallbackSize(deviceId);

  core.transport.send({
    type: 'select-pane',
    deviceId,
    windowId,
    paneId,
    selectToken: generateSelectToken(),
    cols: normalizedSize?.cols,
    rows: normalizedSize?.rows,
  });
}
