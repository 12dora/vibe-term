// 关闭整个 window 前的路由回落判定。与关 pane 同理（见 close-pane-fallback.ts）：
// 关掉 URL 点名的 window 必须先把路由挪到幸存目标再发 close-window，否则 kill 到新快照回来的
// 这段时间里 URL 指向一个已不存在的 window，界面只能显示「连接设备中」遮罩。

import { type SelectionWindowLike, pickActiveSelectionPane } from './selection-recovery';

export type WindowCloseFallback =
  | { kind: 'none' }
  | { kind: 'pane'; windowId: string; paneId: string }
  | { kind: 'device-list' };

/** 其他窗口里挑落点：tmux active 窗口优先，否则第一个还有 pane 的窗口，各取其 active pane。 */
export function pickOtherWindowTarget(
  windows: readonly SelectionWindowLike[],
  excludeWindowId: string
): { windowId: string; paneId: string } | null {
  const others = windows.filter(
    (window) => window.id !== excludeWindowId && window.panes.length > 0
  );
  const nextWindow = others.find((window) => window.active) ?? others[0];
  const nextPane = nextWindow ? pickActiveSelectionPane(nextWindow) : undefined;
  return nextWindow && nextPane ? { windowId: nextWindow.id, paneId: nextPane.id } : null;
}

/**
 * 关闭的不是路由 window 时返回 none（只发 close-window）；是路由 window 时按
 * 其他窗口的 active pane → 设备列表 依次回落。
 */
export function resolveWindowCloseFallback({
  windows,
  routeWindowId,
  closingWindowId,
}: {
  windows: readonly SelectionWindowLike[] | undefined;
  routeWindowId?: string;
  closingWindowId: string;
}): WindowCloseFallback {
  if (!routeWindowId || routeWindowId !== closingWindowId) {
    return { kind: 'none' };
  }
  const target = pickOtherWindowTarget(windows ?? [], closingWindowId);
  return target ? { kind: 'pane', ...target } : { kind: 'device-list' };
}
