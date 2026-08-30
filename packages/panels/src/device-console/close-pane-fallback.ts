// 关闭 pane 前的路由回落判定。
// 关闭 URL 点名的 pane 必须先把路由挪到幸存目标再发 close-pane：否则 kill 到新快照回来的
// 这段时间里 URL 指向的是一个已不存在的 pane，界面只能显示「连接设备中」遮罩。

import { type SelectionWindowLike, pickActiveSelectionPane } from './selection-recovery';

export type ClosePaneFallback =
  | { kind: 'none' }
  | { kind: 'pane'; windowId: string; paneId: string }
  | { kind: 'device-list' };

/**
 * 关闭的不是路由 pane 时返回 none（只发 close-pane）；是路由 pane 时按
 * 同窗剩余 pane（active 优先）→ 其他窗口的 active pane → 设备列表 依次回落。
 */
export function resolveCloseFallback({
  windows,
  routeWindowId,
  routePaneId,
  closingWindowId,
  closingPaneId,
}: {
  windows: readonly SelectionWindowLike[] | undefined;
  routeWindowId?: string;
  routePaneId?: string;
  closingWindowId: string;
  closingPaneId: string;
}): ClosePaneFallback {
  if (!routePaneId || routePaneId !== closingPaneId || routeWindowId !== closingWindowId) {
    return { kind: 'none' };
  }

  const allWindows = windows ?? [];
  const routeWindow = allWindows.find((window) => window.id === routeWindowId);
  if (routeWindow) {
    const remaining = routeWindow.panes.filter((pane) => pane.id !== closingPaneId);
    const sameWindowTarget = remaining.find((pane) => pane.active) ?? remaining[0];
    if (sameWindowTarget) {
      return { kind: 'pane', windowId: routeWindow.id, paneId: sameWindowTarget.id };
    }
  }

  const otherWindows = allWindows.filter(
    (window) => window.id !== routeWindowId && window.panes.length > 0
  );
  const nextWindow = otherWindows.find((window) => window.active) ?? otherWindows[0];
  const nextPane = nextWindow ? pickActiveSelectionPane(nextWindow) : undefined;
  if (nextWindow && nextPane) {
    return { kind: 'pane', windowId: nextWindow.id, paneId: nextPane.id };
  }

  return { kind: 'device-list' };
}
