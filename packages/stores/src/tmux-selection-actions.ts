// 选择面：当前设备的选中 window/pane、待重试的选择事务与最近上报的终端尺寸。

import type { StateSnapshotPayload } from '@tmex/shared';
import { type SelectFailureReason, generateSelectToken } from '@tmex/ws-client';
import type { RuntimeCore } from './runtime';
import type { TmuxStoreAccess } from './tmux-state';

const RESELECT_RETRY_DELAY_MS = 250;

export function snapshotHasPane(
  snapshot: StateSnapshotPayload | undefined,
  paneId: string
): boolean {
  return Boolean(
    snapshot?.session?.windows.some((window) => window.panes.some((pane) => pane.id === paneId))
  );
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

export interface TmuxSelectionActions {
  selectPane(
    deviceId: string,
    windowId: string,
    paneId: string,
    size?: { cols?: number; rows?: number }
  ): void;
  selectWindow(deviceId: string, windowId: string): void;
  focusPane(deviceId: string, windowId: string, paneId: string): void;
  /** 设备重连 / 选择失败后重新选中当前 pane；事务进行中则跳过 */
  maybeReselectCurrentPane(deviceId: string): void;
  /** select 状态机上报失败：非 rejected 时排队一次重试 */
  handleSelectFailed(deviceId: string, reason: SelectFailureReason): void;
  cancelReselect(deviceId: string): void;
  /**
   * 新快照删除了当前选中的 pane：取消它的 select 事务与待重试，并清空选中记录，
   * 避免 ACK/progress 超时与 250ms 重选对着已死 pane 空转（回落交给路由对账）。
   */
  handleSnapshotPaneRemoval(
    deviceId: string,
    previousSnapshot: StateSnapshotPayload | undefined
  ): void;
  /** 记录最近一次上报的终端尺寸，供后续 select-pane 复用 */
  recordTerminalSize(deviceId: string, cols: number, rows: number): void;
  dispose(): void;
}

export function createTmuxSelectionActions(
  core: RuntimeCore,
  access: TmuxStoreAccess
): TmuxSelectionActions {
  const lastReportedTerminalSizes = new Map<string, { cols: number; rows: number; at: number }>();
  const selectRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function cancelReselect(deviceId: string): void {
    const timer = selectRetryTimers.get(deviceId);
    if (timer === undefined) return;
    clearTimeout(timer);
    selectRetryTimers.delete(deviceId);
  }

  function maybeReselectCurrentPane(deviceId: string): void {
    const current = access.getState().selectedPanes[deviceId];
    if (!current) return;

    if (core.selectMachine().getTransaction(deviceId)) {
      return;
    }

    access.getState().selectPane(deviceId, current.windowId, current.paneId);
  }

  return {
    selectPane(deviceId, windowId, paneId, size) {
      if (!deviceId || !windowId || !paneId) return;

      access.setState((prev) => ({
        selectedPanes: { ...prev.selectedPanes, [deviceId]: { windowId, paneId } },
      }));

      const selectToken = generateSelectToken();
      const wantHistory = true;

      if (!core.transport.capabilities.atomicScreen) {
        core.selectMachine().dispatch({
          type: 'SELECT_START',
          deviceId,
          windowId,
          paneId,
          selectToken,
          wantHistory,
        });
      }

      const normalizedSize =
        normalizeTerminalSize(size?.cols, size?.rows) ??
        lastReportedTerminalSizes.get(deviceId) ??
        null;

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
    },

    selectWindow(deviceId, windowId) {
      if (!deviceId || !windowId) return;
      core.transport.send({ type: 'select-window', deviceId, windowId });
    },

    focusPane(deviceId, windowId, paneId) {
      if (!deviceId || !windowId || !paneId) return;
      access.setState((prev) => ({
        selectedPanes: { ...prev.selectedPanes, [deviceId]: { windowId, paneId } },
      }));
      core.transport.send({ type: 'focus-pane', deviceId, windowId, paneId });
    },

    maybeReselectCurrentPane,

    handleSelectFailed(deviceId, reason) {
      if (reason === 'rejected' || selectRetryTimers.has(deviceId)) {
        return;
      }
      const timer = setTimeout(() => {
        selectRetryTimers.delete(deviceId);
        if (access.getState().deviceConnected[deviceId] === false) {
          return;
        }
        maybeReselectCurrentPane(deviceId);
      }, RESELECT_RETRY_DELAY_MS);
      selectRetryTimers.set(deviceId, timer);
    },

    cancelReselect,

    handleSnapshotPaneRemoval(deviceId, previousSnapshot) {
      const current = access.getState().selectedPanes[deviceId];
      if (!current) return;
      // 旧快照里也没有它 ≠ 已关闭：可能是刚建好/深链的 pane，快照还没追上
      if (!snapshotHasPane(previousSnapshot, current.paneId)) return;
      if (snapshotHasPane(access.getState().snapshots[deviceId], current.paneId)) return;

      cancelReselect(deviceId);
      core.selectMachine().abandonPane(deviceId, current.paneId);
      access.setState((prev) => {
        const selected = prev.selectedPanes[deviceId];
        if (!selected || selected.paneId !== current.paneId) return {};
        const nextSelected = { ...prev.selectedPanes };
        delete nextSelected[deviceId];
        return { selectedPanes: nextSelected };
      });
    },

    recordTerminalSize(deviceId, cols, rows) {
      const normalizedSize = normalizeTerminalSize(cols, rows);
      if (!normalizedSize) return;
      lastReportedTerminalSizes.set(deviceId, { ...normalizedSize, at: Date.now() });
    },

    dispose() {
      for (const timer of selectRetryTimers.values()) {
        clearTimeout(timer);
      }
      selectRetryTimers.clear();
    },
  };
}
