// 远端 pane 尺寸回灌：把快照里 tmux 的权威行列写回本地终端。
// 调用点必须排在 select 派发与 active 跟随之后（见 use-pane-size-sync.ts 顶部说明）：
// 它可能触发 fetchPaneHistory，提前会让 history 请求越过同一次提交里的 TMUX_SELECT。

import type { TmuxPane } from '@tmex/shared';
import { selectPaneViewportOwner } from '@tmex/stores';
import { useTmuxStore } from '@tmex/stores/react';
import type { TerminalRef } from '@tmex/terminal-ui';
import { type RefObject, useEffect, useState } from 'react';
import { resolvePaneSizeSyncPlan } from './pane-size-sync-plan';

const REMOTE_PANE_SIZE_GUARD_TTL_MS = 2000;

export function useRemotePaneSize({
  deviceId,
  resolvedPaneId,
  selectedPane,
  isLoading,
  isSplitView,
  canInteractWithPane,
  terminalRef,
  localReportRevision = 0,
}: {
  deviceId?: string;
  resolvedPaneId?: string;
  selectedPane?: TmuxPane;
  isLoading: boolean;
  isSplitView: boolean;
  canInteractWithPane: boolean;
  terminalRef: RefObject<TerminalRef | null>;
  /** 每次本地上报（resize/sync）+1：策略到得晚时，上报可能把本地行列拉回容器尺寸，需再回灌一次 */
  localReportRevision?: number;
}): void {
  const fetchPaneHistory = useTmuxStore((state) => state.fetchPaneHistory);
  // follower 的本地上报永远不会被 tmux 回显：不必等 pending 过期，直接回灌权威尺寸
  const owner = useTmuxStore((state) => selectPaneViewportOwner(state, deviceId, resolvedPaneId));
  const [retryRevision, setRetryRevision] = useState(0);

  useEffect(() => {
    void retryRevision;
    void localReportRevision;
    // 分屏模式：pane 尺寸完全由 layout 驱动（SplitTerminalArea 内部 resize），不走回灌
    if (isSplitView) return;
    if (!canInteractWithPane || !selectedPane || isLoading) return;

    const terminal = terminalRef.current;
    const term = terminal?.getTerminal();
    if (!term) return;

    const plan = resolvePaneSizeSyncPlan({
      now: Date.now(),
      isSplitView,
      canInteractWithPane,
      isLoading,
      remotePane: selectedPane,
      currentSize: { cols: term.cols, rows: term.rows },
      pendingLocalSize: terminal?.getPendingLocalSize() ?? null,
      owner,
      ttlMs: REMOTE_PANE_SIZE_GUARD_TTL_MS,
      hasPaneRoute: Boolean(deviceId && resolvedPaneId),
    });

    if (plan.kind === 'skip') return;
    if (plan.kind === 'retry') {
      const timer = window.setTimeout(() => {
        setRetryRevision((revision) => revision + 1);
      }, plan.delayMs);
      return () => window.clearTimeout(timer);
    }

    if (plan.clearPendingLocalSize) terminal?.clearPendingLocalSize();
    if (!plan.resize) return;

    // 走 TerminalRef.resize 而不是实例的 resize：它同时记下权威尺寸，
    // follow 模式下 convergeSnapshotSize() 才知道快照写完后该收敛到哪个行列
    terminal?.resize(plan.cols, plan.rows);
    if (plan.rebuildHistory && deviceId && resolvedPaneId) {
      fetchPaneHistory(deviceId, resolvedPaneId);
    }
  }, [
    canInteractWithPane,
    deviceId,
    fetchPaneHistory,
    isLoading,
    isSplitView,
    localReportRevision,
    owner,
    resolvedPaneId,
    retryRevision,
    selectedPane,
    terminalRef,
  ]);
}
