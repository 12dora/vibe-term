// 设备控制台的 pane 选择域：URL 是真相源，本 hook 负责把快照 / pane-active 事件 /
// pending 建窗收敛回路由，并处理 select 下发、分屏判定与远端尺寸回灌。
// 纯决策逻辑放在 ./selection-recovery，本文件只做副作用编排。

import type { TmuxPane, TmuxWindow } from '@tmex/shared';
import { type HostServices, encodePaneIdForUrl, hostAppPath } from '@tmex/stores';
import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import {
  type TerminalRef,
  type TimedPaneSelection,
  resolvePendingUserSelection,
  shouldApplyRemotePaneSize,
  shouldIgnoreActivePaneEvent,
  shouldSkipSnapshotFollow,
  shouldTrackPendingRouteSelection,
} from '@tmex/terminal-ui';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  resolveDeviceDefaultSelection,
  resolvePendingCreateWindowAction,
  resolveRouteTarget,
  resolveSnapshotActiveSelection,
} from './selection-recovery';

// URL 目标未出现在快照时的失效判定/回落宽限：覆盖 select 状态机 ackTimeoutMs(1500ms) + 快照传播。
const SELECT_SETTLE_GRACE_MS = 2500;
const REMOTE_PANE_SIZE_GUARD_TTL_MS = 2000;
const PENDING_CREATE_WINDOW_TTL_MS = 5000;
const RECENT_SELECT_REQUEST_TTL_MS = 2000;
const RECENT_SELECT_REQUEST_LIMIT = 8;

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
  isSplitView: boolean;
  canInteractWithPane: boolean;
  handleResize: (cols: number, rows: number) => void;
  handleSync: (cols: number, rows: number) => void;
  handleResizeSettled: () => void;
  handleUserSelectPane: (targetWindowId: string, targetPaneId: string) => void;
}

function paneRoutePath(
  host: HostServices,
  deviceId: string,
  windowId: string,
  paneId: string
): string {
  return hostAppPath(
    host,
    `/devices/${deviceId}/windows/${windowId}/panes/${encodePaneIdForUrl(paneId)}`
  );
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
  const runtime = useRuntime();
  const navigate = useNavigate();

  const selectPane = useTmuxStore((state) => state.selectPane);
  const focusPane = useTmuxStore((state) => state.focusPane);
  const fetchPaneHistory = useTmuxStore((state) => state.fetchPaneHistory);
  const activePaneFromEvent = useTmuxStore((state) =>
    deviceId ? state.activePaneFromEvent[deviceId] : undefined
  );
  const pendingCreateWindowAt = useTmuxStore((state) =>
    deviceId ? state.pendingCreateWindowAt[deviceId] : undefined
  );
  // selection 为纯本地语义的 transport（serverSelection=false）下，select 命令不会真正
  // 驱动 tmux active，跟随 tmux active 改写路由只会把用户刚选中的终端弹回去，必须禁用。
  const serverSelection = runtime.transport.capabilities.serverSelection;

  const autoSelected = useRef(false);
  // Track user-initiated navigation to prevent auto-redirect overwriting it
  const userInitiatedSelectionRef = useRef<TimedPaneSelection | null>(null);
  const recentSelectRequestsRef = useRef<Array<{ windowId: string; paneId: string; at: number }>>(
    []
  );
  const lastHandledActiveRef = useRef<{ windowId: string; paneId: string } | null>(null);
  const lastSnapshotActiveRef = useRef<{ windowId: string; paneId: string } | null>(null);
  // 跟踪当前 Terminal 实例已下发过的 SELECT_START：device/pane 变化时 Terminal 重挂载，
  // 需要让下面的 select 效果重新派发（否则切到其他 device 再切回会命中短路、终端空白）
  const lastDispatchedSelectRef = useRef<string | null>(null);
  // 最近一次完整 select（走 barrier/history）落在哪个 window：
  // 分屏内同 window 切焦点时改走轻量 FOCUS_PANE，避免已渲染 pane 被 reset 重放
  const lastFullSelectWindowRef = useRef<string | null>(null);
  const hasWindowSnapshotRef = useRef(false);
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;

  const [remoteSizeRetryRevision, setRemoteSizeRetryRevision] = useState(0);

  const isLoading = !deviceConnected || !resolvedPaneId;
  const hasWindowSnapshot = Boolean(windows);
  const isWindowMissing = hasWindowSnapshot && Boolean(windowId) && !selectedWindow;
  const isPaneMissing =
    hasWindowSnapshot &&
    Boolean(windowId) &&
    Boolean(resolvedPaneId) &&
    Boolean(selectedWindow) &&
    !selectedPane;

  // URL 点名的 window/pane 不在当前快照 ≠ 目标失效：select 不等快照校验就已下发，
  // 深链目标可能尚未出现在最新快照里（快照传播中、重连中）。若立即按失效处理/回落，
  // 会把刚下发的合法深链 replace 掉。因此给「URL 点名了 window」的场景一个 settle
  // 宽限期（覆盖 select 状态机 ackTimeoutMs=1500ms + 快照传播），宽限内目标仍未出现
  // 才视为失效。宽限值按最佳实践先行。
  const missingSelectionKey =
    isWindowMissing || isPaneMissing ? `${deviceId}:${windowId}:${resolvedPaneId ?? ''}` : null;
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
  const isSelectionSettledMissing =
    missingSelectionKey !== null && settledMissingKey === missingSelectionKey;
  const isSelectionInvalid = isSelectionSettledMissing;
  const canInteractWithPane = Boolean(deviceConnected && resolvedPaneId && !isSelectionInvalid);

  // PC 分屏：≥768px 且当前 window 多 pane 且 layout 可用
  const isSplitView = Boolean(
    !isMobile &&
      selectedWindow &&
      selectedWindow.panes.length > 1 &&
      selectedWindow.layout &&
      !isSelectionInvalid
  );
  const isSplitViewRef = useRef(isSplitView);
  useEffect(() => {
    isSplitViewRef.current = isSplitView;
  }, [isSplitView]);

  const snapshotActiveSelection = useMemo(() => resolveSnapshotActiveSelection(windows), [windows]);

  // 移动端多 pane window：终端上报的尺寸即「单屏适配尺寸」，改道拼接布局
  // （window 宽 = N*cols+(N-1)、even-horizontal，每 pane 恰好一屏），
  // 不得发普通 TERM_RESIZE，否则整窗被压成单 pane 尺寸破坏拼接
  const stackedLayoutTarget =
    isMobile && selectedWindow && selectedWindow.panes.length > 1 ? selectedWindow.id : null;
  const stackedLayoutTargetRef = useRef(stackedLayoutTarget);
  stackedLayoutTargetRef.current = stackedLayoutTarget;
  useEffect(() => {
    if (!deviceConnected || !stackedLayoutTarget) return;
    terminalRef.current?.runPostSelectResize();
  }, [deviceConnected, stackedLayoutTarget, terminalRef]);

  useEffect(() => {
    hasWindowSnapshotRef.current = Boolean(windows) && Boolean(windowId);
  }, [windows, windowId]);

  const navigateToPane = useCallback(
    (targetDeviceId: string, targetWindowId: string, targetPaneId: string) => {
      navigate(paneRoutePath(runtime.host, targetDeviceId, targetWindowId, targetPaneId), {
        replace: true,
      });
    },
    [navigate, runtime.host]
  );

  // Handle resize from terminal - use store directly to avoid unstable callback deps
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
    [deviceId, resolvedPaneId, runtime]
  );

  // Handle sync from terminal
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
    [deviceId, resolvedPaneId, runtime]
  );

  const handleResizeSettled = useCallback(() => {
    if (!deviceId) return;
    runtime.stores.tmux.getState().syncThemeAfterResize(deviceId);
  }, [deviceId, runtime]);

  const getSelectSize = useCallback(
    (targetWindowId?: string, targetPaneId?: string) => {
      const terminal = terminalRef.current;

      // 分屏模式下焦点 Terminal 的容器只是它自己的 pane 区域，
      // select 携带的尺寸应是整个终端区域换算出的 window 尺寸
      if (isSplitViewRef.current) {
        const rect = terminalContainerRef.current?.getBoundingClientRect();
        const cell = terminal?.getCellSize();
        if (rect && cell && rect.width > 0 && rect.height > 0) {
          return {
            cols: Math.max(2, Math.floor(rect.width / cell.width)),
            rows: Math.max(2, Math.floor(rect.height / cell.height)),
          };
        }
        return undefined;
      }

      // 移动端不携带 select 尺寸：整窗尺寸由 stacked layout（多 pane）或
      // Terminal ResizeObserver 的 sync 路径（单 pane）异步驱动，
      // select 只负责切焦点 + 拉 history，不主动 resize
      if (isMobileRef.current) return undefined;

      const terminalSize =
        terminal?.calculateSizeFromContainer() ?? terminal?.getSize() ?? undefined;
      if (terminalSize) {
        return terminalSize;
      }

      if (!targetWindowId || !targetPaneId || !windows) {
        return undefined;
      }

      const targetWindow = windows.find((window) => window.id === targetWindowId);
      const targetPane = targetWindow?.panes.find((pane) => pane.id === targetPaneId);
      if (!targetPane || targetPane.width <= 1 || targetPane.height <= 1) {
        return undefined;
      }

      return {
        cols: targetPane.width,
        rows: targetPane.height,
      };
    },
    [terminalContainerRef, terminalRef, windows]
  );

  const recordSelectRequest = useCallback((targetWindowId: string, targetPaneId: string) => {
    const now = Date.now();
    const next = [
      ...recentSelectRequestsRef.current.filter(
        (request) => now - request.at < RECENT_SELECT_REQUEST_TTL_MS
      ),
      { windowId: targetWindowId, paneId: targetPaneId, at: now },
    ];
    recentSelectRequestsRef.current = next.slice(-RECENT_SELECT_REQUEST_LIMIT);
  }, []);

  // 跟随一个新的 active 目标：下发 select（分屏内同 window 除外，交给 select effect 走
  // 轻量 FOCUS_PANE）并把路由改写过去。
  const followSelection = useCallback(
    (
      targetDeviceId: string,
      target: { windowId: string; paneId: string },
      options?: { forceFullSelect?: boolean }
    ) => {
      const splitSameWindow =
        !options?.forceFullSelect && isSplitViewRef.current && target.windowId === windowId;
      if (!splitSameWindow) {
        const size = getSelectSize(target.windowId, target.paneId);
        recordSelectRequest(target.windowId, target.paneId);
        selectPane(targetDeviceId, target.windowId, target.paneId, size);
      }
      navigateToPane(targetDeviceId, target.windowId, target.paneId);
    },
    [getSelectSize, navigateToPane, recordSelectRequest, selectPane, windowId]
  );

  // 分屏：点击非焦点 pane 切焦点（URL 为真相源，select effect 走轻量 FOCUS_PANE）
  const handleUserSelectPane = useCallback(
    (targetWindowId: string, targetPaneId: string) => {
      if (!deviceId) return;
      userInitiatedSelectionRef.current = {
        windowId: targetWindowId,
        paneId: targetPaneId,
        at: Date.now(),
      };
      navigateToPane(deviceId, targetWindowId, targetPaneId);
    },
    [deviceId, navigateToPane]
  );

  // Ensure device is connected when viewing (host device provider handles actual connection)
  // This effect resets auto-selection logic and related refs when deviceId changes
  useEffect(() => {
    if (!deviceId) return;
    autoSelected.current = false;
    lastHandledActiveRef.current = null;
    lastSnapshotActiveRef.current = null;
    userInitiatedSelectionRef.current = null;
    recentSelectRequestsRef.current = [];
  }, [deviceId]);

  // Reset autoSelected when device connection changes
  useEffect(() => {
    if (!deviceConnected) {
      autoSelected.current = false;
    }
  }, [deviceConnected]);

  // Handle window/pane changes - both external and from sidebar navigation
  useEffect(() => {
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!windowId) return;
    // If snapshot not yet arrived, don't navigate (loading state)
    if (!windows) return;

    const action = resolveRouteTarget({
      windows,
      routeWindowId: windowId,
      routePaneId: resolvedPaneId,
      settledMissing: isSelectionSettledMissing,
    });
    if (action.kind === 'leave-device') {
      navigate(hostAppPath(runtime.host, '/devices'), { replace: true });
      return;
    }
    if (action.kind === 'navigate') {
      navigateToPane(deviceId, action.windowId, action.paneId);
    }
  }, [
    deviceId,
    deviceConnected,
    isSelectionSettledMissing,
    windows,
    windowId,
    resolvedPaneId,
    navigate,
    navigateToPane,
    runtime.host,
  ]);

  // Auto-select pane on initial load only
  useEffect(() => {
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!windows || windows.length === 0) return;
    // window-only routes are resolved by the target-window effect above.
    if (windowId) return;
    // If autoSelect already done, skip
    if (autoSelected.current) return;

    const target = resolveDeviceDefaultSelection({ windows });
    if (!target) return;

    autoSelected.current = true;
    navigateToPane(deviceId, target.windowId, target.paneId);
  }, [deviceConnected, deviceId, navigateToPane, windowId, windows]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 路由身份变化必须重置仅由 ref 持有的派发守卫
  useEffect(() => {
    lastDispatchedSelectRef.current = null;
  }, [deviceId, resolvedPaneId]);

  // isSplitView 翻转会重建 Terminal 实例（单 Terminal ↔ SplitTerminalArea），
  // 焦点 pane 的新实例需要完整 select 重新拉 history，否则空白
  const prevSplitViewRef = useRef(isSplitView);
  useEffect(() => {
    if (prevSplitViewRef.current === isSplitView) return;
    prevSplitViewRef.current = isSplitView;
    lastDispatchedSelectRef.current = null;
    lastFullSelectWindowRef.current = null;
  }, [isSplitView]);

  // Select pane when ready
  useEffect(() => {
    if (!deviceId || !windowId || !resolvedPaneId) return;
    // Allow sending TMUX_SELECT before WS is READY: borsh client will queue messages and flush on READY.
    // Note: We don't check isSelectionInvalid here because when user navigates via URL,
    // the snapshot may not yet reflect the new window, but we should still send the select command.
    if (isLoading || !deviceConnected) return;

    const dispatchKey = `${deviceId}:${windowId}:${resolvedPaneId}`;
    if (lastDispatchedSelectRef.current === dispatchKey) {
      return;
    }
    lastDispatchedSelectRef.current = dispatchKey;

    const canUseLightFocus =
      isSplitView &&
      lastFullSelectWindowRef.current === `${deviceId}:${windowId}` &&
      Boolean(selectedWindow?.panes.some((pane) => pane.id === resolvedPaneId));

    recordSelectRequest(windowId, resolvedPaneId);
    if (canUseLightFocus) {
      focusPane(deviceId, windowId, resolvedPaneId);
      return;
    }

    const size = getSelectSize(windowId, resolvedPaneId);
    selectPane(deviceId, windowId, resolvedPaneId, size);
    lastFullSelectWindowRef.current = `${deviceId}:${windowId}`;
  }, [
    deviceConnected,
    deviceId,
    focusPane,
    getSelectSize,
    isLoading,
    isSplitView,
    recordSelectRequest,
    resolvedPaneId,
    selectPane,
    selectedWindow,
    windowId,
  ]);

  // Treat explicit route selection as authoritative until snapshot/runtime catches up.
  useEffect(() => {
    if (!deviceId || !deviceConnected || !windowId || !resolvedPaneId) {
      return;
    }

    const routeTarget = { windowId, paneId: resolvedPaneId };
    if (
      !shouldTrackPendingRouteSelection({
        routeTarget,
        snapshotActive: snapshotActiveSelection,
        pendingUserSelection: userInitiatedSelectionRef.current,
      })
    ) {
      return;
    }

    userInitiatedSelectionRef.current = {
      windowId: routeTarget.windowId,
      paneId: routeTarget.paneId,
      at: Date.now(),
    };
  }, [deviceConnected, deviceId, resolvedPaneId, snapshotActiveSelection, windowId]);

  // Follow active pane from event/tmux pane-active
  useEffect(() => {
    if (!serverSelection) return;
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!windowId || !resolvedPaneId) return;
    if (!activePaneFromEvent) return;

    const now = Date.now();
    const pendingUserSelection = resolvePendingUserSelection(
      userInitiatedSelectionRef.current,
      now
    );
    userInitiatedSelectionRef.current = pendingUserSelection;

    if (
      shouldIgnoreActivePaneEvent({
        now,
        pendingUserSelection,
        activePaneFromEvent,
        currentRoute: { windowId, paneId: resolvedPaneId },
        recentSelectRequests: recentSelectRequestsRef.current,
        lastHandledActive: lastHandledActiveRef.current,
      })
    ) {
      return;
    }

    lastHandledActiveRef.current = { ...activePaneFromEvent };
    if (
      pendingUserSelection &&
      pendingUserSelection.windowId === activePaneFromEvent.windowId &&
      pendingUserSelection.paneId === activePaneFromEvent.paneId
    ) {
      userInitiatedSelectionRef.current = null;
    }

    followSelection(deviceId, activePaneFromEvent);
  }, [
    deviceId,
    deviceConnected,
    windowId,
    resolvedPaneId,
    activePaneFromEvent,
    followSelection,
    serverSelection,
  ]);

  // Fallback: follow active from snapshot (for environments without pane-active event)
  useEffect(() => {
    if (!serverSelection) return;
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!windows || windows.length === 0) return;

    const currentActive = resolveSnapshotActiveSelection(windows);
    if (!currentActive) return;

    const now = Date.now();
    const pendingUserSelection = resolvePendingUserSelection(
      userInitiatedSelectionRef.current,
      now
    );
    userInitiatedSelectionRef.current = pendingUserSelection;

    // Avoid snapshot-driven "bounce back" shortly after we send TMUX_SELECT.
    if (
      shouldSkipSnapshotFollow({
        now,
        pendingUserSelection,
        snapshotActive: currentActive,
        recentSelectRequests: recentSelectRequestsRef.current,
      })
    ) {
      return;
    }

    // Only follow when active actually changes
    if (
      lastSnapshotActiveRef.current &&
      lastSnapshotActiveRef.current.windowId === currentActive.windowId &&
      lastSnapshotActiveRef.current.paneId === currentActive.paneId
    ) {
      return;
    }

    lastSnapshotActiveRef.current = { ...currentActive };
    if (
      pendingUserSelection &&
      pendingUserSelection.windowId === currentActive.windowId &&
      pendingUserSelection.paneId === currentActive.paneId
    ) {
      userInitiatedSelectionRef.current = null;
    }

    // If current URL matches, no need to navigate
    if (windowId === currentActive.windowId && resolvedPaneId === currentActive.paneId) {
      return;
    }

    followSelection(deviceId, currentActive);
  }, [
    deviceId,
    deviceConnected,
    windows,
    windowId,
    resolvedPaneId,
    followSelection,
    serverSelection,
  ]);

  // Force-follow snapshot active after a user-initiated createWindow.
  // Wait for a snapshot whose active differs from the URL (proving the new
  // window is reflected), then navigate there.
  useEffect(() => {
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!pendingCreateWindowAt) return;

    const clearPending = () => runtime.stores.tmux.getState().clearPendingCreateWindow(deviceId);
    const action = resolvePendingCreateWindowAction({
      pendingAt: pendingCreateWindowAt,
      now: Date.now(),
      ttlMs: PENDING_CREATE_WINDOW_TTL_MS,
      snapshotActive: snapshotActiveSelection,
      routeWindowId: windowId,
      routePaneId: resolvedPaneId,
    });

    if (action.kind === 'clear') {
      clearPending();
      return;
    }
    if (action.kind === 'defer') {
      const timer = window.setTimeout(clearPending, action.delayMs);
      return () => window.clearTimeout(timer);
    }

    const target = { windowId: action.windowId, paneId: action.paneId };
    userInitiatedSelectionRef.current = { ...target, at: Date.now() };
    followSelection(deviceId, target, { forceFullSelect: true });
    clearPending();
  }, [
    deviceId,
    deviceConnected,
    pendingCreateWindowAt,
    snapshotActiveSelection,
    windowId,
    resolvedPaneId,
    followSelection,
    runtime,
  ]);

  // Sync pane size from remote
  useEffect(() => {
    void remoteSizeRetryRevision;
    // 分屏模式：pane 尺寸完全由 layout 驱动（SplitTerminalArea 内部 resize），不走回灌
    if (isSplitView) return;
    if (!canInteractWithPane || !selectedPane || isLoading) return;

    const terminal = terminalRef.current;
    const term = terminal?.getTerminal();
    if (!term) return;

    const remoteCols = Math.max(2, Math.floor(selectedPane.width || 0));
    const remoteRows = Math.max(2, Math.floor(selectedPane.height || 0));
    if (!remoteCols || !remoteRows) return;

    const now = Date.now();
    const remoteSize = { cols: remoteCols, rows: remoteRows };
    const pendingLocalSize = terminal?.getPendingLocalSize() ?? null;
    if (
      !shouldApplyRemotePaneSize({
        now,
        remoteSize,
        pendingLocalSize,
        ttlMs: REMOTE_PANE_SIZE_GUARD_TTL_MS,
      })
    ) {
      const elapsed = Math.max(0, now - (pendingLocalSize?.at ?? now));
      const retryAfterMs = Math.max(1, REMOTE_PANE_SIZE_GUARD_TTL_MS - elapsed + 1);
      const timer = window.setTimeout(() => {
        setRemoteSizeRetryRevision((revision) => revision + 1);
      }, retryAfterMs);
      return () => window.clearTimeout(timer);
    }

    if (pendingLocalSize) terminal?.clearPendingLocalSize();

    if (term.cols === remoteCols && term.rows === remoteRows) {
      return;
    }

    term.resize(remoteCols, remoteRows);
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

  // Listen for user-initiated selection from sidebar
  useEffect(() => {
    const handler = (
      event: CustomEvent<{ deviceId: string; windowId: string; paneId: string }>
    ) => {
      const { deviceId: eventDeviceId, windowId: eventWindowId, paneId } = event.detail;
      // Only track if it's for the current device
      // Note: when switching devices, refs are reset in the deviceId effect above
      if (eventDeviceId === deviceId) {
        userInitiatedSelectionRef.current = { windowId: eventWindowId, paneId, at: Date.now() };
      }
    };

    window.addEventListener('tmex:user-initiated-selection', handler as EventListener);
    return () => {
      window.removeEventListener('tmex:user-initiated-selection', handler as EventListener);
    };
  }, [deviceId]);

  return {
    isWindowMissing,
    isPaneMissing,
    isSelectionInvalid,
    isSplitView,
    canInteractWithPane,
    handleResize,
    handleSync,
    handleResizeSettled,
    handleUserSelectPane,
  };
}
