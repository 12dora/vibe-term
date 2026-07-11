import type { TmuxPane, TmuxWindow } from '@tmex/shared';

export interface SnapshotClosures {
  closedWindows: TmuxWindow[];
  closedPanes: Array<{ pane: TmuxPane; window: TmuxWindow }>;
}

// 快照 diff：窗口整体消失记 closedWindows（其 panes 不再逐个计入，避免关窗时连发）；
// 窗口仍在但 pane 消失记 closedPanes。元数据一律取自 prev（关闭项在 next 中已不存在）。
export function diffSnapshotClosures(
  prev: ReadonlyMap<string, TmuxWindow>,
  next: ReadonlyMap<string, TmuxWindow>
): SnapshotClosures {
  const closedWindows: TmuxWindow[] = [];
  const closedPanes: Array<{ pane: TmuxPane; window: TmuxWindow }> = [];

  for (const [windowId, prevWindow] of prev) {
    const nextWindow = next.get(windowId);
    if (!nextWindow) {
      closedWindows.push(prevWindow);
      continue;
    }
    const nextPaneIds = new Set(nextWindow.panes.map((pane) => pane.id));
    for (const pane of prevWindow.panes) {
      if (!nextPaneIds.has(pane.id)) {
        closedPanes.push({ pane, window: prevWindow });
      }
    }
  }

  return { closedWindows, closedPanes };
}
