// 尺寸域：终端上报的本地 resize/sync 下发，以及远端 pane 尺寸回灌。
// 回灌 effect（useRemotePaneSize）必须排在 select 派发与 active 跟随之后：它可能触发
// fetchPaneHistory，提前会让 history 请求越过同一次提交里的 TMUX_SELECT。

import type { TmuxPane } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import type { TerminalRef } from '@tmex/terminal-ui';
import { type RefObject, useCallback, useEffect, useState } from 'react';
import type { PaneSelectionRefs } from './use-pane-selection-state';
import { useRemotePaneSize } from './use-remote-pane-size';

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

  const { hasWindowSnapshotRef, isMobileRef, stackedLayoutTargetRef } = refs;
  const [localReportRevision, setLocalReportRevision] = useState(0);

  // 移动端多 pane window：终端上报的尺寸即「单屏适配尺寸」，改道拼接布局
  // （window 宽 = N*cols+(N-1)、even-horizontal，每 pane 恰好一屏），
  // 不得发普通的 ResizePane 尺寸声明，否则整窗被压成单 pane 尺寸破坏拼接
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
      setLocalReportRevision((revision) => revision + 1);
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
      setLocalReportRevision((revision) => revision + 1);
    },
    [deviceId, hasWindowSnapshotRef, isMobileRef, resolvedPaneId, runtime, stackedLayoutTargetRef]
  );

  const handleResizeSettled = useCallback(() => {
    if (!deviceId) return;
    runtime.stores.tmux.getState().syncThemeAfterResize(deviceId);
  }, [deviceId, runtime]);

  useRemotePaneSize({
    deviceId,
    resolvedPaneId,
    selectedPane,
    isLoading,
    isSplitView,
    canInteractWithPane,
    terminalRef,
    localReportRevision,
  });

  return { handleResize, handleSync, handleResizeSettled };
}
