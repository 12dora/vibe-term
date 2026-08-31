// select 下发的两件小事：尺寸换算与「最近下发过」的记账（用于压制 tmux active 回声）。
// 从 use-pane-selection-dispatch 拆出来，那边只留路由改写与用户动作编排。

import type { TmuxWindow } from '@tmex/shared';
import type { TerminalRef, TerminalSizeSnapshot } from '@tmex/terminal-ui';
import { type RefObject, useCallback } from 'react';
import {
  appendRecentSelectRequest,
  resolveSnapshotSelectSize,
  resolveSplitSelectSize,
} from './pane-selection-rules';
import type { PaneSelectionRefs } from './use-pane-selection-state';

const RECENT_SELECT_REQUEST_TTL_MS = 2000;
const RECENT_SELECT_REQUEST_LIMIT = 8;

export interface SelectRequestTools {
  getSelectSize: (windowId?: string, paneId?: string) => TerminalSizeSnapshot | undefined;
  recordSelectRequest: (windowId: string, paneId: string) => void;
}

export function useSelectRequest({
  windows,
  terminalRef,
  terminalContainerRef,
  refs,
}: {
  windows?: readonly TmuxWindow[];
  terminalRef: RefObject<TerminalRef | null>;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  refs: PaneSelectionRefs;
}): SelectRequestTools {
  const { isMobileRef, isSplitViewRef, recentSelectRequestsRef } = refs;

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

  return { getSelectSize, recordSelectRequest };
}
