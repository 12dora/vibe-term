export interface SelectionPaneLike {
  id: string;
  active?: boolean;
}

export interface SelectionWindowLike {
  id: string;
  active?: boolean;
  panes: readonly SelectionPaneLike[];
}

export function resolveSettledMissingWindowFallback({
  windows,
  routeWindowId,
  settled,
}: {
  windows: readonly SelectionWindowLike[];
  routeWindowId: string;
  settled: boolean;
}): { windowId: string; paneId: string } | null {
  if (!settled || windows.some((window) => window.id === routeWindowId)) {
    return null;
  }
  const activeWindow = windows.find((window) => window.active && window.panes.length > 0);
  const fallbackWindow = activeWindow ?? windows.find((window) => window.panes.length > 0);
  if (!fallbackWindow) {
    return null;
  }
  const fallbackPane =
    fallbackWindow.panes.find((pane) => pane.active) ?? fallbackWindow.panes[0];
  return fallbackPane ? { windowId: fallbackWindow.id, paneId: fallbackPane.id } : null;
}
