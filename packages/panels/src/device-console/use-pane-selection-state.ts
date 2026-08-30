// 派生选择状态 + 跨副作用域共享的 ref 容器。
// 这里的 effect 必须排在其他 pane 选择 hook 之前：isSplitViewRef / hasWindowSnapshotRef
// 会被同一次提交里后续 effect（select 派发、跟随、尺寸回灌）读取。

import type { TmuxPane, TmuxWindow } from '@tmex/shared';
import type { PaneSelection, TimedPaneSelection } from '@tmex/terminal-ui';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import {
  paneRouteKey,
  resolveConfirmedPaneClosure,
  resolveMissingSelection,
  resolveSplitView,
  resolveStackedLayoutTarget,
} from './pane-selection-rules';
import { resolveSnapshotActiveSelection } from './selection-recovery';

// URL 目标未出现在快照时的失效判定/回落宽限：覆盖 select 状态机 ackTimeoutMs(1500ms) + 快照传播。
const SELECT_SETTLE_GRACE_MS = 2500;

export interface PaneSelectionRefs {
  autoSelectedRef: RefObject<boolean>;
  /** 用户主动发起的选择，用于压制 tmux active 回声把路由弹回去 */
  userInitiatedSelectionRef: RefObject<TimedPaneSelection | null>;
  recentSelectRequestsRef: RefObject<TimedPaneSelection[]>;
  lastHandledActiveRef: RefObject<PaneSelection | null>;
  lastSnapshotActiveRef: RefObject<PaneSelection | null>;
  // 跟踪当前 Terminal 实例已下发过的 SELECT_START：device/pane 变化时 Terminal 重挂载，
  // 需要让 select 效果重新派发（否则切到其他 device 再切回会命中短路、终端空白）
  lastDispatchedSelectRef: RefObject<string | null>;
  // 最近一次完整 select（走 barrier/history）落在哪个 window：
  // 分屏内同 window 切焦点时改走轻量 FOCUS_PANE，避免已渲染 pane 被 reset 重放
  lastFullSelectWindowRef: RefObject<string | null>;
  hasWindowSnapshotRef: RefObject<boolean>;
  isMobileRef: RefObject<boolean>;
  isSplitViewRef: RefObject<boolean>;
  stackedLayoutTargetRef: RefObject<string | null>;
}

export interface PaneSelectionState {
  isLoading: boolean;
  isWindowMissing: boolean;
  isPaneMissing: boolean;
  /** 路由 pane 曾在快照里、现已消失：不等宽限期就可以判定它被关闭了 */
  isPaneConfirmedClosed: boolean;
  isSelectionSettledMissing: boolean;
  isSelectionInvalid: boolean;
  canInteractWithPane: boolean;
  isSplitView: boolean;
  /** 移动端多 pane window 的拼接布局目标 windowId */
  stackedLayoutTarget: string | null;
  snapshotActiveSelection: PaneSelection | null;
  refs: PaneSelectionRefs;
}

export function usePaneSelectionState({
  deviceId,
  windowId,
  resolvedPaneId,
  windows,
  selectedWindow,
  selectedPane,
  deviceConnected,
  isMobile,
}: {
  deviceId?: string;
  windowId?: string;
  resolvedPaneId?: string;
  windows?: readonly TmuxWindow[];
  selectedWindow?: TmuxWindow;
  selectedPane?: TmuxPane;
  deviceConnected: boolean;
  isMobile: boolean;
}): PaneSelectionState {
  const autoSelectedRef = useRef(false);
  const userInitiatedSelectionRef = useRef<TimedPaneSelection | null>(null);
  const recentSelectRequestsRef = useRef<TimedPaneSelection[]>([]);
  const lastHandledActiveRef = useRef<PaneSelection | null>(null);
  const lastSnapshotActiveRef = useRef<PaneSelection | null>(null);
  const lastDispatchedSelectRef = useRef<string | null>(null);
  const lastFullSelectWindowRef = useRef<string | null>(null);
  const hasWindowSnapshotRef = useRef(false);
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;

  const isLoading = !deviceConnected || !resolvedPaneId;
  const { isWindowMissing, isPaneMissing, missingSelectionKey } = resolveMissingSelection({
    deviceId,
    windowId,
    resolvedPaneId,
    hasWindowSnapshot: Boolean(windows),
    hasSelectedWindow: Boolean(selectedWindow),
    hasSelectedPane: Boolean(selectedPane),
  });

  // URL 点名的 window/pane 不在当前快照 ≠ 目标失效：select 不等快照校验就已下发，
  // 深链目标可能尚未出现在最新快照里（快照传播中、重连中）。若立即按失效处理/回落，
  // 会把刚下发的合法深链 replace 掉。因此给「URL 点名了 window」的场景一个 settle
  // 宽限期，宽限内目标仍未出现才视为失效。
  const [settledMissingKey, setSettledMissingKey] = useState<string | null>(null);
  useEffect(() => {
    setSettledMissingKey(null);
    if (!missingSelectionKey) return;
    const timer = window.setTimeout(
      () => setSettledMissingKey(missingSelectionKey),
      SELECT_SETTLE_GRACE_MS
    );
    return () => window.clearTimeout(timer);
  }, [missingSelectionKey]);

  // 曾在快照里见过 URL 点名的 pane：它之后从快照消失就是「被关闭」，无需等宽限期
  const routeKey = paneRouteKey({ deviceId, windowId, resolvedPaneId });
  const seenPaneRouteKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedPane) seenPaneRouteKeyRef.current = routeKey;
  }, [routeKey, selectedPane]);

  const isPaneConfirmedClosed = resolveConfirmedPaneClosure({
    routeKey,
    seenRouteKey: seenPaneRouteKeyRef.current,
    isPaneMissing,
    hasSelectedPane: Boolean(selectedPane),
  });

  // 宽限期只用于「快照还没追上」的深链；已确认关闭的 pane 直接让路由对账回落
  const isSelectionInvalid =
    missingSelectionKey !== null && settledMissingKey === missingSelectionKey;
  const isSelectionSettledMissing = isSelectionInvalid || isPaneConfirmedClosed;
  const canInteractWithPane = Boolean(
    deviceConnected && resolvedPaneId && !isSelectionInvalid && !isPaneConfirmedClosed
  );

  const isSplitView = resolveSplitView({ isMobile, selectedWindow, isSelectionInvalid });
  const isSplitViewRef = useRef(isSplitView);
  useEffect(() => {
    isSplitViewRef.current = isSplitView;
  }, [isSplitView]);

  const stackedLayoutTarget = resolveStackedLayoutTarget({ isMobile, selectedWindow });
  const stackedLayoutTargetRef = useRef(stackedLayoutTarget);
  stackedLayoutTargetRef.current = stackedLayoutTarget;

  useEffect(() => {
    hasWindowSnapshotRef.current = Boolean(windows) && Boolean(windowId);
  }, [windows, windowId]);

  // 切设备时清空仅由 ref 持有的跟随/去重状态，避免上个设备的回声污染新设备
  useEffect(() => {
    if (!deviceId) return;
    autoSelectedRef.current = false;
    lastHandledActiveRef.current = null;
    lastSnapshotActiveRef.current = null;
    userInitiatedSelectionRef.current = null;
    recentSelectRequestsRef.current = [];
  }, [deviceId]);

  useEffect(() => {
    if (!deviceConnected) {
      autoSelectedRef.current = false;
    }
  }, [deviceConnected]);

  const snapshotActiveSelection = useMemo(() => resolveSnapshotActiveSelection(windows), [windows]);

  const refs = useMemo<PaneSelectionRefs>(
    () => ({
      autoSelectedRef,
      userInitiatedSelectionRef,
      recentSelectRequestsRef,
      lastHandledActiveRef,
      lastSnapshotActiveRef,
      lastDispatchedSelectRef,
      lastFullSelectWindowRef,
      hasWindowSnapshotRef,
      isMobileRef,
      isSplitViewRef,
      stackedLayoutTargetRef,
    }),
    []
  );

  return {
    isLoading,
    isWindowMissing,
    isPaneMissing,
    isPaneConfirmedClosed,
    isSelectionSettledMissing,
    isSelectionInvalid,
    canInteractWithPane,
    isSplitView,
    stackedLayoutTarget,
    snapshotActiveSelection,
    refs,
  };
}
