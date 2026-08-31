// 选择面：当前设备的选中 window/pane、待重试的选择事务与最近上报的终端尺寸。

import type { StateSnapshotPayload } from '@tmex/shared';
import type { SelectFailureReason } from '@tmex/ws-client';
import { createPaneStreamGaps } from './pane-stream-gaps';
import { createReselectRetry } from './reselect-retry';
import type { RuntimeCore } from './runtime';
import { dispatchSelectPane, normalizeTerminalSize } from './select-pane-dispatch';
import { observeSelectHistory, observeSelectLiveResume } from './select-transaction-observers';
import type { TmuxStoreAccess } from './tmux-state';

const RESELECT_RETRY_DELAY_MS = 250;

export function snapshotPaneIds(snapshot: StateSnapshotPayload | undefined): Set<string> {
  const ids = new Set<string>();
  for (const window of snapshot?.session?.windows ?? []) {
    for (const pane of window.panes) ids.add(pane.id);
  }
  return ids;
}

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
   * 目标 pane 的终端仍挂载并订阅中（前端保活池），缓冲即最新：
   * 只让 tmux 切焦点，不要 history、也不 reset 终端。
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
  /**
   * 设备流整体中断（断开 / 自动重连中）：作废在途选择事务与重试，
   * 并把该设备已知的所有 pane 记为有缺口——中断期间谁都可能漏字节，
   * 恢复后必须各自走一次落定的冷 select 才重新具备 warm 资格。
   */
  handleDeviceStreamInterrupted(deviceId: string): void;
  /** 观察到某 token 的 history 会被真正写进终端（router 在派发 HISTORY 前调用） */
  observeSelectHistory(deviceId: string, selectToken: Uint8Array): void;
  /** 观察到某 token 的事务干净地恢复 live（router 在派发 LIVE_RESUME 前调用） */
  observeSelectLiveResume(deviceId: string, selectToken: Uint8Array): void;
  dispose(): void;
}

export function createTmuxSelectionActions(
  core: RuntimeCore,
  access: TmuxStoreAccess
): TmuxSelectionActions {
  const lastReportedTerminalSizes = new Map<string, { cols: number; rows: number; at: number }>();
  const gaps = createPaneStreamGaps();
  const retry = createReselectRetry(RESELECT_RETRY_DELAY_MS, (deviceId) => {
    if (access.getState().deviceConnected[deviceId] === false) return;
    maybeReselectCurrentPane(deviceId);
  });

  const dispatchDeps = {
    core,
    gaps,
    inFlightPaneId: (deviceId: string) =>
      core.transport.capabilities.atomicScreen
        ? null
        : (core.selectMachine().getTransaction(deviceId)?.paneId ?? null),
    fallbackSize: (deviceId: string) => lastReportedTerminalSizes.get(deviceId) ?? null,
  };

  // 重连、以及 select 失败后的重来：这个 pane 的终端都没拿到过权威 history，
  // 一律按缺口处理，由紧接着的冷 select 补洞（只有落定才清缺口）。
  function maybeReselectCurrentPane(deviceId: string): void {
    const current = access.getState().selectedPanes[deviceId];
    if (!current) return;

    if (core.selectMachine().getTransaction(deviceId)) {
      return;
    }

    gaps.markGapped(deviceId, current.paneId);
    access.getState().selectPane(deviceId, current.windowId, current.paneId);
  }

  return {
    selectPane(deviceId, windowId, paneId, size, options) {
      if (!deviceId || !windowId || !paneId) return;

      access.setState((prev) => ({
        selectedPanes: { ...prev.selectedPanes, [deviceId]: { windowId, paneId } },
      }));

      dispatchSelectPane(dispatchDeps, {
        deviceId,
        windowId,
        paneId,
        size,
        warm: options?.warm === true,
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
      // 补洞的 select 没跑完：缺口留着，等下一次成功的冷 select
      gaps.abortRepair(deviceId);
      if (reason === 'rejected') return;
      retry.schedule(deviceId);
    },

    cancelReselect: retry.cancel,

    handleSnapshotPaneRemoval(deviceId, previousSnapshot) {
      gaps.retainLivePanes(deviceId, snapshotPaneIds(access.getState().snapshots[deviceId]));

      const current = access.getState().selectedPanes[deviceId];
      if (!current) return;
      // 旧快照里也没有它 ≠ 已关闭：可能是刚建好/深链的 pane，快照还没追上
      if (!snapshotHasPane(previousSnapshot, current.paneId)) return;
      if (snapshotHasPane(access.getState().snapshots[deviceId], current.paneId)) return;

      retry.cancel(deviceId);
      gaps.markGapped(deviceId, current.paneId);
      core.selectMachine().abandonPane(deviceId, current.paneId);
      access.setState((prev) => {
        const selected = prev.selectedPanes[deviceId];
        if (!selected || selected.paneId !== current.paneId) return {};
        const nextSelected = { ...prev.selectedPanes };
        delete nextSelected[deviceId];
        return { selectedPanes: nextSelected };
      });
    },

    handleDeviceStreamInterrupted(deviceId) {
      retry.cancel(deviceId);
      core.selectMachine().cleanup(deviceId);
      gaps.resetDevice(deviceId);
      gaps.markDeviceGapped(deviceId, snapshotPaneIds(access.getState().snapshots[deviceId]));
    },

    observeSelectHistory(deviceId, selectToken) {
      observeSelectHistory(core.selectMachine(), gaps, deviceId, selectToken);
    },

    observeSelectLiveResume(deviceId, selectToken) {
      observeSelectLiveResume(core.selectMachine(), gaps, deviceId, selectToken);
    },

    recordTerminalSize(deviceId, cols, rows) {
      const normalizedSize = normalizeTerminalSize(cols, rows);
      if (!normalizedSize) return;
      lastReportedTerminalSizes.set(deviceId, { ...normalizedSize, at: Date.now() });
    },

    dispose() {
      retry.dispose();
      gaps.clear();
    },
  };
}
