export interface SelectionPaneLike {
  id: string;
  active?: boolean;
}

export interface SelectionWindowLike {
  id: string;
  active?: boolean;
  panes: readonly SelectionPaneLike[];
}

export function resolveDeviceDefaultSelection({
  windows,
  routeWindowId,
}: {
  windows: readonly SelectionWindowLike[];
  routeWindowId?: string;
}): { windowId: string; paneId: string } | null {
  if (routeWindowId) return null;
  const activeWindow = windows.find((window) => window.active && window.panes.length > 0);
  const targetWindow = activeWindow ?? windows.find((window) => window.panes.length > 0);
  if (!targetWindow) return null;
  const targetPane = targetWindow.panes.find((pane) => pane.active) ?? targetWindow.panes[0];
  return targetPane ? { windowId: targetWindow.id, paneId: targetPane.id } : null;
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
  return resolveDeviceDefaultSelection({ windows });
}
