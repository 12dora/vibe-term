// tmux active 的跟随域：pane-active 事件、快照 active 回落、createWindow 后强制跟随，
// 以及压制回声所需的 pending 用户选择记账。
// 这些 effect 共享 userInitiatedSelectionRef / recentSelectRequestsRef，执行顺序即
// 「记账 → 事件跟随 → 快照跟随 → 建窗跟随」，调换会改变跟随目标与 select 变体。

import type { TmuxWindow } from '@tmex/shared';
import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import { type PaneSelection, shouldTrackPendingRouteSelection } from '@tmex/terminal-ui';
import { useEffect } from 'react';
import { resolveActivePaneEventFollow, resolveSnapshotActiveFollow } from './pane-selection-rules';
import {
  resolvePendingCreateWindowAction,
  resolveSnapshotActiveSelection,
} from './selection-recovery';
import type { PaneSelectionDispatch } from './use-pane-selection-dispatch';
import type { PaneSelectionRefs } from './use-pane-selection-state';

const PENDING_CREATE_WINDOW_TTL_MS = 5000;

export function usePaneActiveFollow({
  deviceId,
  windowId,
  resolvedPaneId,
  windows,
  deviceConnected,
  snapshotActiveSelection,
  refs,
  dispatch,
}: {
  deviceId?: string;
  windowId?: string;
  resolvedPaneId?: string;
  windows?: readonly TmuxWindow[];
  deviceConnected: boolean;
  snapshotActiveSelection: PaneSelection | null;
  refs: PaneSelectionRefs;
  dispatch: PaneSelectionDispatch;
}): void {
  const runtime = useRuntime();
  const activePaneFromEvent = useTmuxStore((state) =>
    deviceId ? state.activePaneFromEvent[deviceId] : undefined
  );
  const pendingCreateWindowAt = useTmuxStore((state) =>
    deviceId ? state.pendingCreateWindowAt[deviceId] : undefined
  );
  // selection 为纯本地语义的 transport（serverSelection=false）下，select 命令不会真正
  // 驱动 tmux active，跟随 tmux active 改写路由只会把用户刚选中的终端弹回去，必须禁用。
  const serverSelection = runtime.transport.capabilities.serverSelection;

  const {
    lastHandledActiveRef,
    lastSnapshotActiveRef,
    recentSelectRequestsRef,
    userInitiatedSelectionRef,
  } = refs;
  const { followSelection } = dispatch;

  // 显式的路由选择在快照/运行时追上之前视为权威
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

    userInitiatedSelectionRef.current = { ...routeTarget, at: Date.now() };
  }, [
    deviceConnected,
    deviceId,
    resolvedPaneId,
    snapshotActiveSelection,
    userInitiatedSelectionRef,
    windowId,
  ]);

  // 跟随 pane-active 事件
  useEffect(() => {
    if (!serverSelection) return;
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!windowId || !resolvedPaneId) return;
    if (!activePaneFromEvent) return;

    const decision = resolveActivePaneEventFollow({
      now: Date.now(),
      activePaneFromEvent,
      currentRoute: { windowId, paneId: resolvedPaneId },
      pendingUserSelection: userInitiatedSelectionRef.current,
      recentSelectRequests: recentSelectRequestsRef.current,
      lastHandledActive: lastHandledActiveRef.current,
    });

    userInitiatedSelectionRef.current = decision.prunedPendingUserSelection;
    if (!decision.follow) return;

    lastHandledActiveRef.current = decision.handledActive;
    if (decision.clearPendingUserSelection) {
      userInitiatedSelectionRef.current = null;
    }

    followSelection(deviceId, decision.follow);
  }, [
    deviceId,
    deviceConnected,
    windowId,
    resolvedPaneId,
    activePaneFromEvent,
    followSelection,
    lastHandledActiveRef,
    recentSelectRequestsRef,
    serverSelection,
    userInitiatedSelectionRef,
  ]);

  // 回落：无 pane-active 事件的环境下由快照 active 驱动
  useEffect(() => {
    if (!serverSelection) return;
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!windows || windows.length === 0) return;

    const currentActive = resolveSnapshotActiveSelection(windows);
    if (!currentActive) return;

    const decision = resolveSnapshotActiveFollow({
      now: Date.now(),
      snapshotActive: currentActive,
      currentRoute: { windowId, paneId: resolvedPaneId },
      pendingUserSelection: userInitiatedSelectionRef.current,
      recentSelectRequests: recentSelectRequestsRef.current,
      lastSnapshotActive: lastSnapshotActiveRef.current,
    });

    userInitiatedSelectionRef.current = decision.prunedPendingUserSelection;
    if (!decision.handledActive) return;

    lastSnapshotActiveRef.current = decision.handledActive;
    if (decision.clearPendingUserSelection) {
      userInitiatedSelectionRef.current = null;
    }

    if (!decision.follow) return;
    followSelection(deviceId, decision.follow);
  }, [
    deviceId,
    deviceConnected,
    windows,
    windowId,
    resolvedPaneId,
    followSelection,
    lastSnapshotActiveRef,
    recentSelectRequestsRef,
    serverSelection,
    userInitiatedSelectionRef,
  ]);

  // 用户主动 createWindow 后强制跟随快照 active：等到 active 与 URL 不一致
  // （证明新窗口已入快照）再跟过去。
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
    userInitiatedSelectionRef,
  ]);

  // 侧边栏发起的选择：登记为 pending 用户选择，压制随后的 active 回声
  useEffect(() => {
    const handler = (
      event: CustomEvent<{ deviceId: string; windowId: string; paneId: string }>
    ) => {
      const { deviceId: eventDeviceId, windowId: eventWindowId, paneId } = event.detail;
      // 切设备时这些 ref 由 usePaneSelectionState 统一重置，这里只认当前设备
      if (eventDeviceId === deviceId) {
        userInitiatedSelectionRef.current = { windowId: eventWindowId, paneId, at: Date.now() };
      }
    };

    window.addEventListener('tmex:user-initiated-selection', handler as EventListener);
    return () => {
      window.removeEventListener('tmex:user-initiated-selection', handler as EventListener);
    };
  }, [deviceId, userInitiatedSelectionRef]);
}
