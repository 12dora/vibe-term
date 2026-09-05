// 选择面：当前设备的选中 window/pane 与最近上报的终端尺寸。

import type { StateSnapshotPayload } from '@tmex/shared';
import type { RuntimeCore } from './runtime';
import { dispatchSelectPane, normalizeTerminalSize } from './select-pane-dispatch';
import type { TmuxStoreAccess } from './tmux-state';

export function snapshotHasPane(
  snapshot: StateSnapshotPayload | undefined,
  paneId: string
): boolean {
  return Boolean(
    snapshot?.session?.windows.some((window) => window.panes.some((pane) => pane.id === paneId))
  );
}

export { normalizeTerminalSize };

export interface SelectPaneOptions {
  /**
   * 目标 pane 的终端仍挂载并订阅中（前端保活池）。canonical 链路下画面由 pane 自己的
   * 截屏事务重建，切换不再区分冷热，因此该提示不改变下发内容；保留是为了调用方
   *（保活池）语义完整，也便于以后重新利用。
   */
  warm?: boolean;
}

export interface TmuxSelectionActions {
  selectPane(
    deviceId: string,
    windowId: string,
    paneId: string,
    size?: { cols?: number; rows?: number },
    options?: SelectPaneOptions
  ): void;
  selectWindow(deviceId: string, windowId: string): void;
  focusPane(deviceId: string, windowId: string, paneId: string): void;
  /**
   * 新快照删除了当前选中的 pane：清空选中记录，避免路由继续指向已死 pane
   *（回落交给路由对账）。
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

  return {
    selectPane(deviceId, windowId, paneId, size) {
      if (!deviceId || !windowId || !paneId) return;

      access.setState((prev) => ({
        selectedPanes: { ...prev.selectedPanes, [deviceId]: { windowId, paneId } },
      }));

      dispatchSelectPane(
        { core, fallbackSize: (id) => lastReportedTerminalSizes.get(id) ?? null },
        { deviceId, windowId, paneId, size }
      );
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

    handleSnapshotPaneRemoval(deviceId, previousSnapshot) {
      const current = access.getState().selectedPanes[deviceId];
      if (!current) return;
      // 旧快照里也没有它 ≠ 已关闭：可能是刚建好/深链的 pane，快照还没追上
      if (!snapshotHasPane(previousSnapshot, current.paneId)) return;
      if (snapshotHasPane(access.getState().snapshots[deviceId], current.paneId)) return;

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
      lastReportedTerminalSizes.clear();
    },
  };
}
