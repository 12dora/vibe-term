// pane 选择域的纯决策：所有输入显式传参，不碰 React / DOM / store。
// 副作用编排见 ./use-pane-*.ts，路由对账见 ./selection-recovery。

import {
  type PaneSelection,
  type TerminalSizeSnapshot,
  type TimedPaneSelection,
  type TimedTerminalSizeSnapshot,
  resolvePendingUserSelection,
  shouldApplyRemotePaneSize,
  shouldIgnoreActivePaneEvent,
  shouldSkipSnapshotFollow,
} from '@tmex/terminal-ui';

export interface RuleWindowLike {
  id: string;
  layout?: string;
  panes: readonly { id: string; width: number; height: number }[];
}

export interface MissingSelectionState {
  isWindowMissing: boolean;
  isPaneMissing: boolean;
  /** 非空表示 URL 目标当前不在快照中，作为 settle 宽限计时的身份 */
  missingSelectionKey: string | null;
}

export function resolveMissingSelection({
  deviceId,
  windowId,
  resolvedPaneId,
  hasWindowSnapshot,
  hasSelectedWindow,
  hasSelectedPane,
}: {
  deviceId?: string;
  windowId?: string;
  resolvedPaneId?: string;
  hasWindowSnapshot: boolean;
  hasSelectedWindow: boolean;
  hasSelectedPane: boolean;
}): MissingSelectionState {
  const isWindowMissing = hasWindowSnapshot && Boolean(windowId) && !hasSelectedWindow;
  const isPaneMissing =
    hasWindowSnapshot &&
    Boolean(windowId) &&
    Boolean(resolvedPaneId) &&
    hasSelectedWindow &&
    !hasSelectedPane;
  return {
    isWindowMissing,
    isPaneMissing,
    missingSelectionKey:
      isWindowMissing || isPaneMissing ? `${deviceId}:${windowId}:${resolvedPaneId ?? ''}` : null,
  };
}

/** PC 分屏：非移动端 + 当前 window 多 pane + layout 可用 + 选择未失效 */
export function resolveSplitView({
  isMobile,
  selectedWindow,
  isSelectionInvalid,
}: {
  isMobile: boolean;
  selectedWindow?: RuleWindowLike;
  isSelectionInvalid: boolean;
}): boolean {
  return Boolean(
    !isMobile &&
      selectedWindow &&
      selectedWindow.panes.length > 1 &&
      selectedWindow.layout &&
      !isSelectionInvalid
  );
}

/** 移动端多 pane window 走拼接布局，返回需要拼接的 windowId */
export function resolveStackedLayoutTarget({
  isMobile,
  selectedWindow,
}: {
  isMobile: boolean;
  selectedWindow?: RuleWindowLike;
}): string | null {
  return isMobile && selectedWindow && selectedWindow.panes.length > 1 ? selectedWindow.id : null;
}

export function appendRecentSelectRequest(
  requests: readonly TimedPaneSelection[],
  request: TimedPaneSelection,
  { ttlMs, limit }: { ttlMs: number; limit: number }
): TimedPaneSelection[] {
  const next = [...requests.filter((entry) => request.at - entry.at < ttlMs), request];
  return next.slice(-limit);
}

export type SelectDispatchAction =
  | { kind: 'skip' }
  | { kind: 'focus'; dispatchKey: string }
  | { kind: 'select'; dispatchKey: string; fullSelectWindowKey: string };

/**
 * 路由就绪后是否下发 select：同一路由身份只派发一次；分屏内同 window 且该 window
 * 已做过完整 select 时改走轻量 FOCUS_PANE，避免已渲染 pane 被 reset 重放。
 */
export function resolveSelectDispatch({
  deviceId,
  windowId,
  paneId,
  lastDispatchedKey,
  isSplitView,
  lastFullSelectWindowKey,
  selectedWindowPaneIds,
}: {
  deviceId: string;
  windowId: string;
  paneId: string;
  lastDispatchedKey: string | null;
  isSplitView: boolean;
  lastFullSelectWindowKey: string | null;
  selectedWindowPaneIds: readonly string[] | undefined;
}): SelectDispatchAction {
  const dispatchKey = `${deviceId}:${windowId}:${paneId}`;
  if (lastDispatchedKey === dispatchKey) {
    return { kind: 'skip' };
  }

  const fullSelectWindowKey = `${deviceId}:${windowId}`;
  const canUseLightFocus =
    isSplitView &&
    lastFullSelectWindowKey === fullSelectWindowKey &&
    Boolean(selectedWindowPaneIds?.some((id) => id === paneId));

  return canUseLightFocus
    ? { kind: 'focus', dispatchKey }
    : { kind: 'select', dispatchKey, fullSelectWindowKey };
}

/** 分屏下焦点 Terminal 的容器只是它自己的 pane 区域，select 尺寸按整个终端区域换算 */
export function resolveSplitSelectSize(
  rect: { width: number; height: number } | null | undefined,
  cell: { width: number; height: number } | null | undefined
): TerminalSizeSnapshot | undefined {
  // cell 尺寸在字体就绪前可能为 0，除下去会得到 Infinity 并被当作 select 尺寸发上线，
  // 量不到就不带尺寸，交给 Terminal 的 sync 路径异步补
  if (
    !rect ||
    !cell ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    cell.width <= 0 ||
    cell.height <= 0
  ) {
    return undefined;
  }
  return {
    cols: Math.max(2, Math.floor(rect.width / cell.width)),
    rows: Math.max(2, Math.floor(rect.height / cell.height)),
  };
}

/** 本地量不到尺寸时回落到快照里目标 pane 的尺寸 */
export function resolveSnapshotSelectSize({
  windows,
  windowId,
  paneId,
}: {
  windows: readonly RuleWindowLike[] | undefined;
  windowId?: string;
  paneId?: string;
}): TerminalSizeSnapshot | undefined {
  if (!windowId || !paneId || !windows) {
    return undefined;
  }
  const targetWindow = windows.find((window) => window.id === windowId);
  const targetPane = targetWindow?.panes.find((pane) => pane.id === paneId);
  if (!targetPane || targetPane.width <= 1 || targetPane.height <= 1) {
    return undefined;
  }
  return { cols: targetPane.width, rows: targetPane.height };
}

export interface FollowDecision {
  /** 过期裁剪后的 pending 用户选择，需回写 ref */
  prunedPendingUserSelection: TimedPaneSelection | null;
  /** 非空表示本次 active 已被处理，需记入对应的「上次处理」ref */
  handledActive: PaneSelection | null;
  /** pending 用户选择已被本次 active 兑现，需清空 ref */
  clearPendingUserSelection: boolean;
  /** 非空表示需要跟随到该目标 */
  follow: PaneSelection | null;
}

function matches(left: PaneSelection | null | undefined, right: PaneSelection): boolean {
  return Boolean(left && left.windowId === right.windowId && left.paneId === right.paneId);
}

/** pane-active 事件驱动的跟随判定 */
export function resolveActivePaneEventFollow({
  now,
  activePaneFromEvent,
  currentRoute,
  pendingUserSelection,
  recentSelectRequests,
  lastHandledActive,
}: {
  now: number;
  activePaneFromEvent: PaneSelection;
  currentRoute: PaneSelection;
  pendingUserSelection: TimedPaneSelection | null;
  recentSelectRequests: TimedPaneSelection[];
  lastHandledActive: PaneSelection | null;
}): FollowDecision {
  const pruned = resolvePendingUserSelection(pendingUserSelection, now);

  if (
    shouldIgnoreActivePaneEvent({
      now,
      pendingUserSelection: pruned,
      activePaneFromEvent,
      currentRoute,
      recentSelectRequests,
      lastHandledActive,
    })
  ) {
    return {
      prunedPendingUserSelection: pruned,
      handledActive: null,
      clearPendingUserSelection: false,
      follow: null,
    };
  }

  return {
    prunedPendingUserSelection: pruned,
    handledActive: { ...activePaneFromEvent },
    clearPendingUserSelection: matches(pruned, activePaneFromEvent),
    follow: activePaneFromEvent,
  };
}

/** 无 pane-active 事件的环境下由快照 active 驱动的跟随判定 */
export function resolveSnapshotActiveFollow({
  now,
  snapshotActive,
  currentRoute,
  pendingUserSelection,
  recentSelectRequests,
  lastSnapshotActive,
}: {
  now: number;
  snapshotActive: PaneSelection;
  currentRoute: { windowId?: string; paneId?: string };
  pendingUserSelection: TimedPaneSelection | null;
  recentSelectRequests: TimedPaneSelection[];
  lastSnapshotActive: PaneSelection | null;
}): FollowDecision {
  const pruned = resolvePendingUserSelection(pendingUserSelection, now);

  // 刚下发 TMUX_SELECT 后快照可能仍是旧 active，跟随会把用户的选择弹回去
  if (
    shouldSkipSnapshotFollow({
      now,
      pendingUserSelection: pruned,
      snapshotActive,
      recentSelectRequests,
    })
  ) {
    return {
      prunedPendingUserSelection: pruned,
      handledActive: null,
      clearPendingUserSelection: false,
      follow: null,
    };
  }

  if (matches(lastSnapshotActive, snapshotActive)) {
    return {
      prunedPendingUserSelection: pruned,
      handledActive: null,
      clearPendingUserSelection: false,
      follow: null,
    };
  }

  const routeMatchesActive =
    currentRoute.windowId === snapshotActive.windowId &&
    currentRoute.paneId === snapshotActive.paneId;

  return {
    prunedPendingUserSelection: pruned,
    handledActive: { ...snapshotActive },
    clearPendingUserSelection: matches(pruned, snapshotActive),
    follow: routeMatchesActive ? null : snapshotActive,
  };
}

export type RemotePaneSizeAction =
  | { kind: 'skip' }
  | { kind: 'retry'; delayMs: number }
  | { kind: 'apply'; cols: number; rows: number; clearPendingLocalSize: boolean; resize: boolean };

/**
 * 远端 pane 尺寸回灌判定：分屏由 layout 驱动不回灌；本地刚发出的 resize 未被确认前
 * 让位并安排重试；尺寸一致时只清 pending 不重排。
 */
export function resolveRemotePaneSizeSync({
  now,
  isSplitView,
  canInteractWithPane,
  isLoading,
  remotePane,
  currentSize,
  pendingLocalSize,
  ttlMs,
}: {
  now: number;
  isSplitView: boolean;
  canInteractWithPane: boolean;
  isLoading: boolean;
  remotePane: { width: number; height: number } | null | undefined;
  currentSize: TerminalSizeSnapshot | null;
  pendingLocalSize: TimedTerminalSizeSnapshot | null;
  ttlMs: number;
}): RemotePaneSizeAction {
  if (isSplitView) return { kind: 'skip' };
  if (!canInteractWithPane || !remotePane || isLoading) return { kind: 'skip' };
  if (!currentSize) return { kind: 'skip' };

  const cols = Math.max(2, Math.floor(remotePane.width || 0));
  const rows = Math.max(2, Math.floor(remotePane.height || 0));

  if (!shouldApplyRemotePaneSize({ now, remoteSize: { cols, rows }, pendingLocalSize, ttlMs })) {
    const elapsed = Math.max(0, now - (pendingLocalSize?.at ?? now));
    return { kind: 'retry', delayMs: Math.max(1, ttlMs - elapsed + 1) };
  }

  return {
    kind: 'apply',
    cols,
    rows,
    clearPendingLocalSize: Boolean(pendingLocalSize),
    resize: currentSize.cols !== cols || currentSize.rows !== rows,
  };
}
