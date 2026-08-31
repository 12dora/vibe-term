// 一次 select-pane 的下发：取舍判定 → 清理失效的旧事务 → 起（或不起）选择事务 → 发命令。
// 从 tmux-selection-actions 的工厂里拆出来，保持那边只做状态面与生命周期编排。

import { generateSelectToken } from '@tmex/ws-client';
import { type PaneStreamGaps, resolveSelectPaneDecision } from './pane-stream-gaps';
import type { RuntimeCore } from './runtime';

export interface SelectPaneRequest {
  deviceId: string;
  windowId: string;
  paneId: string;
  size?: { cols?: number; rows?: number };
  warm: boolean;
}

export interface SelectPaneDispatchDeps {
  core: RuntimeCore;
  gaps: PaneStreamGaps;
  /** 客户端仍未落定的事务针对的 pane（整屏原子下发的链路恒为 null） */
  inFlightPaneId(deviceId: string): string | null;
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
  { core, gaps, inFlightPaneId, fallbackSize }: SelectPaneDispatchDeps,
  { deviceId, windowId, paneId, size, warm }: SelectPaneRequest
): void {
  const selectToken = generateSelectToken();
  const inFlight = inFlightPaneId(deviceId);

  const decision = resolveSelectPaneDecision({
    paneId,
    warmRequested: warm,
    targetGapped: gaps.isGapped(deviceId, paneId),
    inFlightPaneId: inFlight,
  });

  if (decision.abandonPaneId) core.selectMachine().abandonPane(deviceId, decision.abandonPaneId);
  if (decision.gapPaneId) gaps.markGapped(deviceId, decision.gapPaneId);

  const { wantHistory } = decision;
  if (wantHistory && !core.transport.capabilities.atomicScreen) {
    // 缺口要等观察到「history 落地 + live 恢复」才清；中途失败/切走/门控溢出都得留着
    if (gaps.isGapped(deviceId, paneId)) gaps.beginRepair(deviceId, paneId, selectToken);
    core.selectMachine().dispatch({
      type: 'SELECT_START',
      deviceId,
      windowId,
      paneId,
      selectToken,
      wantHistory,
    });
  }

  const normalizedSize = normalizeTerminalSize(size?.cols, size?.rows) ?? fallbackSize(deviceId);

  core.transport.send({
    type: 'select-pane',
    deviceId,
    windowId,
    paneId,
    selectToken,
    wantHistory,
    cols: normalizedSize?.cols,
    rows: normalizedSize?.rows,
  });
}
