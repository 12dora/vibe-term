// 设备控制台的 pane 选择域入口：URL 是真相源，本 hook 只做子域编排。
// 子域按副作用执行顺序调用，顺序即语义，不可调换：
//   1. usePaneSelectionState  派生状态 + 共享 ref（isSplitViewRef 等需先于消费者更新）
//   2. usePaneRouteReconciliation  路由对账 / 自动选中 / select 派发
//   3. usePaneActiveFollow  pending 记账 → pane-active 事件 → 快照 active → 建窗跟随
//   4. usePaneSizeSync  本地 resize 下发 + 远端尺寸回灌（回灌会拉 history，必须最后）
// 纯决策逻辑见 ./pane-selection-rules 与 ./selection-recovery。

import type { TmuxPane, TmuxWindow } from '@tmex/shared';
import type { TerminalRef } from '@tmex/terminal-ui';
import type { RefObject } from 'react';
import { usePaneActiveFollow } from './use-pane-active-follow';
import { usePaneRouteReconciliation } from './use-pane-route-reconciliation';
import { usePaneSelectionDispatch } from './use-pane-selection-dispatch';
import { usePaneSelectionState } from './use-pane-selection-state';
import { usePaneSizeSync } from './use-pane-size-sync';

export interface UseDevicePaneSelectionOptions {
  deviceId?: string;
  windowId?: string;
  /** 已归一的 pane id（非路由段原值） */
  resolvedPaneId?: string;
  windows?: readonly TmuxWindow[];
  selectedWindow?: TmuxWindow;
  selectedPane?: TmuxPane;
  deviceConnected: boolean;
  isMobile: boolean;
  terminalRef: RefObject<TerminalRef | null>;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
}

export interface DevicePaneSelection {
  isWindowMissing: boolean;
  isPaneMissing: boolean;
  /** 宽限期后 URL 目标仍不在快照中：视为已关闭 */
  isSelectionInvalid: boolean;
  /** 快照已确认 URL 点名的 pane 被关闭：不要再为它挂载 Terminal */
  isPaneConfirmedClosed: boolean;
  isSplitView: boolean;
  canInteractWithPane: boolean;
  handleResize: (cols: number, rows: number) => void;
  handleSync: (cols: number, rows: number) => void;
  handleResizeSettled: () => void;
  handleUserSelectPane: (targetWindowId: string, targetPaneId: string) => void;
  handleClosePane: (targetWindowId: string, targetPaneId: string) => void;
}

export function useDevicePaneSelection({
  deviceId,
  windowId,
  resolvedPaneId,
  windows,
  selectedWindow,
  selectedPane,
  deviceConnected,
  isMobile,
  terminalRef,
  terminalContainerRef,
}: UseDevicePaneSelectionOptions): DevicePaneSelection {
  const state = usePaneSelectionState({
    deviceId,
    windowId,
    resolvedPaneId,
    windows,
    selectedWindow,
    selectedPane,
    deviceConnected,
    isMobile,
  });

  const dispatch = usePaneSelectionDispatch({
    deviceId,
    windowId,
    resolvedPaneId,
    windows,
    terminalRef,
    terminalContainerRef,
    refs: state.refs,
  });

  usePaneRouteReconciliation({
    deviceId,
    windowId,
    resolvedPaneId,
    windows,
    selectedWindow,
    deviceConnected,
    isLoading: state.isLoading,
    isSplitView: state.isSplitView,
    isSelectionSettledMissing: state.isSelectionSettledMissing,
    refs: state.refs,
    dispatch,
  });

  usePaneActiveFollow({
    deviceId,
    windowId,
    resolvedPaneId,
    windows,
    deviceConnected,
    snapshotActiveSelection: state.snapshotActiveSelection,
    refs: state.refs,
    dispatch,
  });

  const { handleResize, handleSync, handleResizeSettled } = usePaneSizeSync({
    deviceId,
    resolvedPaneId,
    selectedPane,
    deviceConnected,
    isLoading: state.isLoading,
    isSplitView: state.isSplitView,
    canInteractWithPane: state.canInteractWithPane,
    stackedLayoutTarget: state.stackedLayoutTarget,
    terminalRef,
    refs: state.refs,
  });

  return {
    isWindowMissing: state.isWindowMissing,
    isPaneMissing: state.isPaneMissing,
    isSelectionInvalid: state.isSelectionInvalid,
    isPaneConfirmedClosed: state.isPaneConfirmedClosed,
    isSplitView: state.isSplitView,
    canInteractWithPane: state.canInteractWithPane,
    handleResize,
    handleSync,
    handleResizeSettled,
    handleUserSelectPane: dispatch.handleUserSelectPane,
    handleClosePane: dispatch.handleClosePane,
  };
}
