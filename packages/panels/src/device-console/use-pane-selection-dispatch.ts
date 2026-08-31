// select / 路由改写的共享下发口：route 对账与 active 跟随都经由这里发消息，
// 保证 select 尺寸计算、请求去重记录与 URL 改写只有一份实现。本 hook 不含 effect，
// 放在 hook 调用序列的任意位置都不影响副作用执行顺序。

import type { TmuxWindow } from '@tmex/shared';
import { type HostServices, encodePaneIdForUrl, hostAppPath } from '@tmex/stores';
import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import type { PaneSelection, TerminalRef, TerminalSizeSnapshot } from '@tmex/terminal-ui';
import { type RefObject, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router';
import { resolveCloseFallback } from './close-pane-fallback';
import { isRetainedPane } from './terminal-keep-alive';
import type { PaneSelectionRefs } from './use-pane-selection-state';
import { useSelectRequest } from './use-select-request';

export interface PaneSelectionDispatch {
  navigateToPane: (deviceId: string, windowId: string, paneId: string) => void;
  navigateToDeviceList: () => void;
  getSelectSize: (windowId?: string, paneId?: string) => TerminalSizeSnapshot | undefined;
  recordSelectRequest: (windowId: string, paneId: string) => void;
  followSelection: (
    deviceId: string,
    target: PaneSelection,
    options?: { forceFullSelect?: boolean }
  ) => void;
  handleUserSelectPane: (windowId: string, paneId: string) => void;
  /** 关闭 pane：若关的是 URL 点名的 pane，先把路由挪到幸存目标再发 close-pane */
  handleClosePane: (windowId: string, paneId: string) => void;
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

export function usePaneSelectionDispatch({
  deviceId,
  windowId,
  resolvedPaneId,
  windows,
  terminalRef,
  terminalContainerRef,
  refs,
}: {
  deviceId?: string;
  windowId?: string;
  resolvedPaneId?: string;
  windows?: readonly TmuxWindow[];
  terminalRef: RefObject<TerminalRef | null>;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  refs: PaneSelectionRefs;
}): PaneSelectionDispatch {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const selectPane = useTmuxStore((state) => state.selectPane);
  const closePane = useTmuxStore((state) => state.closePane);

  const { isSplitViewRef, userInitiatedSelectionRef } = refs;

  // URL 点名的 pane：每次渲染同步成入参，并在导航时立刻更新。
  // 同一次点击里可能已经先发生过一次 navigate（焦点跟随），此时入参还停在上一帧的值，
  // 关闭回落若照着旧值判断就会得出「关的不是路由 pane」，URL 最后落在已删除的 pane 上。
  const routePaneRef = useRef<{ windowId?: string; paneId?: string }>({
    windowId,
    paneId: resolvedPaneId,
  });
  routePaneRef.current = { windowId, paneId: resolvedPaneId };

  const navigateToPane = useCallback(
    (targetDeviceId: string, targetWindowId: string, targetPaneId: string) => {
      routePaneRef.current = { windowId: targetWindowId, paneId: targetPaneId };
      navigate(paneRoutePath(runtime.host, targetDeviceId, targetWindowId, targetPaneId), {
        replace: true,
      });
    },
    [navigate, runtime.host]
  );

  const navigateToDeviceList = useCallback(() => {
    navigate(hostAppPath(runtime.host, '/devices'), { replace: true });
  }, [navigate, runtime.host]);

  const { getSelectSize, recordSelectRequest } = useSelectRequest({
    windows,
    terminalRef,
    terminalContainerRef,
    refs,
  });

  // 跟随一个新的 active 目标：下发 select（分屏内同 window 除外，交给 select effect 走
  // 轻量 FOCUS_PANE）并把路由改写过去。
  const followSelection = useCallback(
    (targetDeviceId: string, target: PaneSelection, options?: { forceFullSelect?: boolean }) => {
      const splitSameWindow =
        !options?.forceFullSelect && isSplitViewRef.current && target.windowId === windowId;
      if (!splitSameWindow) {
        const size = getSelectSize(target.windowId, target.paneId);
        recordSelectRequest(target.windowId, target.paneId);
        const warm = isRetainedPane(targetDeviceId, target.paneId);
        selectPane(
          targetDeviceId,
          target.windowId,
          target.paneId,
          size,
          warm ? { warm: true } : undefined
        );
      }
      navigateToPane(targetDeviceId, target.windowId, target.paneId);
    },
    [getSelectSize, isSplitViewRef, navigateToPane, recordSelectRequest, selectPane, windowId]
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
    [deviceId, navigateToPane, userInitiatedSelectionRef]
  );

  // 关闭 pane：路由指向它时先落到幸存目标（本窗剩余 pane → 其他窗口 → 设备列表），
  // 再发 close-pane，避免 URL 短暂指向已删除的 pane
  const handleClosePane = useCallback(
    (targetWindowId: string, targetPaneId: string) => {
      if (!deviceId) return;
      const route = routePaneRef.current;
      const fallback = resolveCloseFallback({
        windows,
        routeWindowId: route.windowId,
        routePaneId: route.paneId,
        closingWindowId: targetWindowId,
        closingPaneId: targetPaneId,
      });
      if (fallback.kind === 'pane') {
        userInitiatedSelectionRef.current = {
          windowId: fallback.windowId,
          paneId: fallback.paneId,
          at: Date.now(),
        };
        navigateToPane(deviceId, fallback.windowId, fallback.paneId);
      } else if (fallback.kind === 'device-list') {
        navigateToDeviceList();
      }
      closePane(deviceId, targetPaneId);
    },
    [closePane, deviceId, navigateToDeviceList, navigateToPane, userInitiatedSelectionRef, windows]
  );

  return {
    navigateToPane,
    navigateToDeviceList,
    getSelectSize,
    recordSelectRequest,
    followSelection,
    handleUserSelectPane,
    handleClosePane,
  };
}
