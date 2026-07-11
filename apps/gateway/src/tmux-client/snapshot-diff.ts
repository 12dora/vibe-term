import type { TmuxPane, TmuxWindow } from '@tmex/shared';

export interface SnapshotClosures {
  closedWindows: TmuxWindow[];
  closedPanes: Array<{ pane: TmuxPane; window: TmuxWindow }>;
}

// 快照 diff：窗口整体消失记 closedWindows（其 panes 不再逐个计入，避免关窗时连发）；
// 窗口仍在但 pane 消失记 closedPanes。pane 是否消失以 next 全部窗口的 pane 并集判定，
// move-pane / break-pane 把 pane 挪进其他窗口（含新建窗口）时不算关闭。
// 元数据一律取自 prev（关闭项在 next 中已不存在）。
export function diffSnapshotClosures(
  prev: ReadonlyMap<string, TmuxWindow>,
  next: ReadonlyMap<string, TmuxWindow>
): SnapshotClosures {
  const closedWindows: TmuxWindow[] = [];
  const closedPanes: Array<{ pane: TmuxPane; window: TmuxWindow }> = [];

  const nextPaneIds = new Set<string>();
  for (const window of next.values()) {
    for (const pane of window.panes) {
      nextPaneIds.add(pane.id);
    }
  }

  for (const [windowId, prevWindow] of prev) {
    const nextWindow = next.get(windowId);
    if (!nextWindow) {
      closedWindows.push(prevWindow);
      continue;
    }
    for (const pane of prevWindow.panes) {
      if (!nextPaneIds.has(pane.id)) {
        closedPanes.push({ pane, window: prevWindow });
      }
    }
  }

  return { closedWindows, closedPanes };
}
