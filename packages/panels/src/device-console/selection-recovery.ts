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
  const targetPane = pickActiveSelectionPane(targetWindow);
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

export function pickActiveSelectionPane(
  window: SelectionWindowLike
): SelectionPaneLike | undefined {
  return window.panes.find((pane) => pane.active) ?? window.panes[0];
}

export type RouteSelectionAction =
  | { kind: 'stay' }
  | { kind: 'leave-device' }
  | { kind: 'navigate'; windowId: string; paneId: string };

/** 路由点名的 window/pane 与快照对账：决定停留、回落到设备列表，还是改写路由。 */
export function resolveRouteTarget({
  windows,
  routeWindowId,
  routePaneId,
  settledMissing,
}: {
  windows: readonly SelectionWindowLike[];
  routeWindowId: string;
  routePaneId?: string;
  settledMissing: boolean;
}): RouteSelectionAction {
  if (windows.length === 0) {
    return { kind: 'leave-device' };
  }

  const targetWindow = windows.find((window) => window.id === routeWindowId);
  if (!targetWindow) {
    const fallback = resolveSettledMissingWindowFallback({
      windows,
      routeWindowId,
      settled: settledMissing,
    });
    return fallback ? { kind: 'navigate', ...fallback } : { kind: 'stay' };
  }

  if (!routePaneId) {
    const targetPane = pickActiveSelectionPane(targetWindow);
    return targetPane
      ? { kind: 'navigate', windowId: targetWindow.id, paneId: targetPane.id }
      : { kind: 'stay' };
  }

  if (targetWindow.panes.some((pane) => pane.id === routePaneId)) {
    return { kind: 'stay' };
  }

  // pane 不在本窗口时先查它是否被 move/break 到了其他窗口——是则跟随过去
  // （否则抢先导航回本窗口会与 pane-active 事件竞争，把 tmux 焦点拉回来）
  const relocatedWindow = windows.find((window) =>
    window.panes.some((pane) => pane.id === routePaneId)
  );
  if (relocatedWindow) {
    return { kind: 'navigate', windowId: relocatedWindow.id, paneId: routePaneId };
  }

  // 快照里没有 ≠ 已关闭：settle 宽限内等快照追上，宽限后仍未出现才按已关闭回落
  if (!settledMissing) {
    return { kind: 'stay' };
  }

  const activePane = pickActiveSelectionPane(targetWindow);
  return activePane
    ? { kind: 'navigate', windowId: targetWindow.id, paneId: activePane.id }
    : { kind: 'stay' };
}

export function resolveSnapshotActiveSelection(
  windows: readonly SelectionWindowLike[] | undefined
): { windowId: string; paneId: string } | null {
  if (!windows || windows.length === 0) {
    return null;
  }
  const activeWindow = windows.find((window) => window.active);
  const activePane = activeWindow?.panes.find((pane) => pane.active);
  if (!activeWindow || !activePane) {
    return null;
  }
  return { windowId: activeWindow.id, paneId: activePane.id };
}

export type PendingCreateWindowAction =
  | { kind: 'clear' }
  | { kind: 'defer'; delayMs: number }
  | { kind: 'follow'; windowId: string; paneId: string };

/** createWindow 后强制跟随快照 active：等到 active 与 URL 不一致（证明新窗口已入快照）再跟过去。 */
export function resolvePendingCreateWindowAction({
  pendingAt,
  now,
  ttlMs,
  snapshotActive,
  routeWindowId,
  routePaneId,
}: {
  pendingAt: number;
  now: number;
  ttlMs: number;
  snapshotActive: { windowId: string; paneId: string } | null;
  routeWindowId?: string;
  routePaneId?: string;
}): PendingCreateWindowAction {
  const elapsed = now - pendingAt;
  if (elapsed > ttlMs) {
    return { kind: 'clear' };
  }
  if (!snapshotActive) {
    return { kind: 'defer', delayMs: ttlMs - elapsed };
  }
  if (routeWindowId === snapshotActive.windowId && routePaneId === snapshotActive.paneId) {
    return { kind: 'defer', delayMs: ttlMs - elapsed };
  }
  return { kind: 'follow', ...snapshotActive };
}
