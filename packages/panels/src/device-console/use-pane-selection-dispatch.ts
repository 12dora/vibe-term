// select / 路由改写的共享下发口：route 对账与 active 跟随都经由这里发消息，
// 保证 select 尺寸计算、请求去重记录与 URL 改写只有一份实现。本 hook 不含 effect，
// 放在 hook 调用序列的任意位置都不影响副作用执行顺序。

import type { TmuxWindow } from '@tmex/shared';
import { type HostServices, encodePaneIdForUrl, hostAppPath } from '@tmex/stores';
import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import type { PaneSelection, TerminalRef, TerminalSizeSnapshot } from '@tmex/terminal-ui';
import { type RefObject, useCallback } from 'react';
import { useNavigate } from 'react-router';
import {
  appendRecentSelectRequest,
  resolveSnapshotSelectSize,
  resolveSplitSelectSize,
} from './pane-selection-rules';
import type { PaneSelectionRefs } from './use-pane-selection-state';

const RECENT_SELECT_REQUEST_TTL_MS = 2000;
const RECENT_SELECT_REQUEST_LIMIT = 8;

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
  windows,
  terminalRef,
  terminalContainerRef,
  refs,
}: {
  deviceId?: string;
  windowId?: string;
  windows?: readonly TmuxWindow[];
  terminalRef: RefObject<TerminalRef | null>;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  refs: PaneSelectionRefs;
}): PaneSelectionDispatch {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const selectPane = useTmuxStore((state) => state.selectPane);

  const { isMobileRef, isSplitViewRef, recentSelectRequestsRef, userInitiatedSelectionRef } = refs;

  const navigateToPane = useCallback(
    (targetDeviceId: string, targetWindowId: string, targetPaneId: string) => {
      navigate(paneRoutePath(runtime.host, targetDeviceId, targetWindowId, targetPaneId), {
        replace: true,
      });
    },
    [navigate, runtime.host]
  );

  const navigateToDeviceList = useCallback(() => {
    navigate(hostAppPath(runtime.host, '/devices'), { replace: true });
  }, [navigate, runtime.host]);

  const getSelectSize = useCallback(
    (targetWindowId?: string, targetPaneId?: string) => {
      const terminal = terminalRef.current;

      if (isSplitViewRef.current) {
        return resolveSplitSelectSize(
          terminalContainerRef.current?.getBoundingClientRect(),
          terminal?.getCellSize()
        );
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

      return resolveSnapshotSelectSize({
        windows,
        windowId: targetWindowId,
        paneId: targetPaneId,
      });
    },
    [isMobileRef, isSplitViewRef, terminalContainerRef, terminalRef, windows]
  );

  const recordSelectRequest = useCallback(
    (targetWindowId: string, targetPaneId: string) => {
      recentSelectRequestsRef.current = appendRecentSelectRequest(
        recentSelectRequestsRef.current,
        { windowId: targetWindowId, paneId: targetPaneId, at: Date.now() },
        { ttlMs: RECENT_SELECT_REQUEST_TTL_MS, limit: RECENT_SELECT_REQUEST_LIMIT }
      );
    },
    [recentSelectRequestsRef]
  );

  // 跟随一个新的 active 目标：下发 select（分屏内同 window 除外，交给 select effect 走
  // 轻量 FOCUS_PANE）并把路由改写过去。
  const followSelection = useCallback(
    (targetDeviceId: string, target: PaneSelection, options?: { forceFullSelect?: boolean }) => {
      const splitSameWindow =
        !options?.forceFullSelect && isSplitViewRef.current && target.windowId === windowId;
      if (!splitSameWindow) {
        const size = getSelectSize(target.windowId, target.paneId);
        recordSelectRequest(target.windowId, target.paneId);
        selectPane(targetDeviceId, target.windowId, target.paneId, size);
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

  return {
    navigateToPane,
    navigateToDeviceList,
    getSelectSize,
    recordSelectRequest,
    followSelection,
    handleUserSelectPane,
  };
}
