// 尺寸域：终端上报的本地 resize/sync 下发，以及远端 pane 尺寸回灌。
// 回灌 effect 必须排在 select 派发与 active 跟随之后：它可能触发 fetchPaneHistory，
// 提前会让 history 请求越过同一次提交里的 TMUX_SELECT。

import type { TmuxPane } from '@tmex/shared';
import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import type { TerminalRef } from '@tmex/terminal-ui';
import { type RefObject, useCallback, useEffect, useState } from 'react';
import { resolveRemotePaneSizeSync } from './pane-selection-rules';
import type { PaneSelectionRefs } from './use-pane-selection-state';

const REMOTE_PANE_SIZE_GUARD_TTL_MS = 2000;

export interface PaneSizeSync {
  handleResize: (cols: number, rows: number) => void;
  handleSync: (cols: number, rows: number) => void;
  handleResizeSettled: () => void;
}

export function usePaneSizeSync({
  deviceId,
  resolvedPaneId,
  selectedPane,
  deviceConnected,
  isLoading,
  isSplitView,
  canInteractWithPane,
  stackedLayoutTarget,
  terminalRef,
  refs,
}: {
  deviceId?: string;
  resolvedPaneId?: string;
  selectedPane?: TmuxPane;
  deviceConnected: boolean;
  isLoading: boolean;
  isSplitView: boolean;
  canInteractWithPane: boolean;
  stackedLayoutTarget: string | null;
  terminalRef: RefObject<TerminalRef | null>;
  refs: PaneSelectionRefs;
}): PaneSizeSync {
  const runtime = useRuntime();
  const fetchPaneHistory = useTmuxStore((state) => state.fetchPaneHistory);
  const [remoteSizeRetryRevision, setRemoteSizeRetryRevision] = useState(0);

  const { hasWindowSnapshotRef, isMobileRef, stackedLayoutTargetRef } = refs;

  // 移动端多 pane window：终端上报的尺寸即「单屏适配尺寸」，改道拼接布局
  // （window 宽 = N*cols+(N-1)、even-horizontal，每 pane 恰好一屏），
  // 不得发普通 TERM_RESIZE，否则整窗被压成单 pane 尺寸破坏拼接
  useEffect(() => {
    if (!deviceConnected || !stackedLayoutTarget) return;
    terminalRef.current?.runPostSelectResize();
  }, [deviceConnected, stackedLayoutTarget, terminalRef]);

  // 直接读 store，避免回调依赖不稳定
  const handleResize = useCallback(
    (cols: number, rows: number) => {
      if (!deviceId || !resolvedPaneId) return;
      const stackedWindowId = stackedLayoutTargetRef.current;
      if (stackedWindowId) {
        runtime.stores.tmux.getState().applyStackedLayout(deviceId, stackedWindowId, cols, rows);
        return;
      }
      if (isMobileRef.current && !hasWindowSnapshotRef.current) return;
      runtime.stores.tmux.getState().resizePane(deviceId, resolvedPaneId, cols, rows);
    },
    [deviceId, hasWindowSnapshotRef, isMobileRef, resolvedPaneId, runtime, stackedLayoutTargetRef]
  );

  const handleSync = useCallback(
    (cols: number, rows: number) => {
      if (!deviceId || !resolvedPaneId) return;
      const stackedWindowId = stackedLayoutTargetRef.current;
      if (stackedWindowId) {
        runtime.stores.tmux.getState().applyStackedLayout(deviceId, stackedWindowId, cols, rows);
        return;
      }
      if (isMobileRef.current && !hasWindowSnapshotRef.current) return;
      runtime.stores.tmux.getState().syncPaneSize(deviceId, resolvedPaneId, cols, rows);
    },
    [deviceId, hasWindowSnapshotRef, isMobileRef, resolvedPaneId, runtime, stackedLayoutTargetRef]
  );

  const handleResizeSettled = useCallback(() => {
    if (!deviceId) return;
    runtime.stores.tmux.getState().syncThemeAfterResize(deviceId);
  }, [deviceId, runtime]);

  useEffect(() => {
    void remoteSizeRetryRevision;
    // 分屏模式：pane 尺寸完全由 layout 驱动（SplitTerminalArea 内部 resize），不走回灌
    if (isSplitView) return;
    if (!canInteractWithPane || !selectedPane || isLoading) return;

    const terminal = terminalRef.current;
    const term = terminal?.getTerminal();
    if (!term) return;

    const action = resolveRemotePaneSizeSync({
      now: Date.now(),
      isSplitView,
      canInteractWithPane,
      isLoading,
      remotePane: selectedPane,
      currentSize: { cols: term.cols, rows: term.rows },
      pendingLocalSize: terminal?.getPendingLocalSize() ?? null,
      ttlMs: REMOTE_PANE_SIZE_GUARD_TTL_MS,
    });

    if (action.kind === 'skip') return;
    if (action.kind === 'retry') {
      const timer = window.setTimeout(() => {
        setRemoteSizeRetryRevision((revision) => revision + 1);
      }, action.delayMs);
      return () => window.clearTimeout(timer);
    }

    if (action.clearPendingLocalSize) terminal?.clearPendingLocalSize();
    if (!action.resize) return;

    // 走 TerminalRef.resize 而不是实例的 resize：它同时记下权威尺寸，
    // follow 模式下 convergeSnapshotSize() 才知道快照写完后该收敛到哪个行列
    terminal?.resize(action.cols, action.rows);
    // 远端 resize 后本地 reflow 与 tmux reflow 不保证一致（差一行即让 TUI 的
    // 相对移动重绘永久错位），重拉 history 以 tmux 权威状态重建本地屏幕；
    // fetch gate 会缓冲期间的 live 输出保序
    if (deviceId && resolvedPaneId) {
      fetchPaneHistory(deviceId, resolvedPaneId);
    }
  }, [
    canInteractWithPane,
    deviceId,
    fetchPaneHistory,
    isLoading,
    isSplitView,
    resolvedPaneId,
    remoteSizeRetryRevision,
    selectedPane,
    terminalRef,
  ]);

  return { handleResize, handleSync, handleResizeSettled };
}
