import { describe, expect, test } from 'bun:test';
import {
  appendRecentSelectRequest,
  paneRouteKey,
  resolveActivePaneEventFollow,
  resolveConfirmedPaneClosure,
  resolveMissingSelection,
  resolveRemotePaneSizeSync,
  resolveSelectDispatch,
  resolveSnapshotActiveFollow,
  resolveSnapshotSelectSize,
  resolveSplitSelectSize,
  resolveSplitView,
  resolveStackedLayoutTarget,
} from './pane-selection-rules';

const pane = (id: string, width = 80, height = 24) => ({ id, width, height });

describe('resolveMissingSelection', () => {
  test('reports nothing before the first snapshot', () => {
    expect(
      resolveMissingSelection({
        deviceId: 'd1',
        windowId: '@1',
        resolvedPaneId: '%1',
        hasWindowSnapshot: false,
        hasSelectedWindow: false,
        hasSelectedPane: false,
      })
    ).toEqual({ isWindowMissing: false, isPaneMissing: false, missingSelectionKey: null });
  });

  test('flags a missing window and keys the settle timer by route identity', () => {
    expect(
      resolveMissingSelection({
        deviceId: 'd1',
        windowId: '@9',
        resolvedPaneId: '%9',
        hasWindowSnapshot: true,
        hasSelectedWindow: false,
        hasSelectedPane: false,
      })
    ).toEqual({ isWindowMissing: true, isPaneMissing: false, missingSelectionKey: 'd1:@9:%9' });
  });

  test('flags a missing pane only when the window resolved', () => {
    expect(
      resolveMissingSelection({
        deviceId: 'd1',
        windowId: '@1',
        resolvedPaneId: '%9',
        hasWindowSnapshot: true,
        hasSelectedWindow: true,
        hasSelectedPane: false,
      })
    ).toEqual({ isWindowMissing: false, isPaneMissing: true, missingSelectionKey: 'd1:@1:%9' });
  });

  test('a window-only route with a resolved window is not missing', () => {
    expect(
      resolveMissingSelection({
        deviceId: 'd1',
        windowId: '@1',
        hasWindowSnapshot: true,
        hasSelectedWindow: true,
        hasSelectedPane: false,
      })
    ).toEqual({ isWindowMissing: false, isPaneMissing: false, missingSelectionKey: null });
  });
});

describe('resolveConfirmedPaneClosure', () => {
  const routeKey = paneRouteKey({ deviceId: 'd1', windowId: '@1', resolvedPaneId: '%1' });

  test('confirms the closure only for a pane that was in a snapshot before', () => {
    expect(
      resolveConfirmedPaneClosure({
        routeKey,
        seenRouteKey: routeKey,
        isPaneMissing: true,
        hasSelectedPane: false,
      })
    ).toBe(true);
  });

  test('waits for the settle grace when the target was never seen', () => {
    expect(
      resolveConfirmedPaneClosure({
        routeKey,
        seenRouteKey: null,
        isPaneMissing: true,
        hasSelectedPane: false,
      })
    ).toBe(false);
    expect(
      resolveConfirmedPaneClosure({
        routeKey,
        seenRouteKey: paneRouteKey({ deviceId: 'd1', windowId: '@1', resolvedPaneId: '%9' }),
        isPaneMissing: true,
        hasSelectedPane: false,
      })
    ).toBe(false);
  });

  test('reports nothing while the pane is still in the snapshot', () => {
    expect(
      resolveConfirmedPaneClosure({
        routeKey,
        seenRouteKey: routeKey,
        isPaneMissing: false,
        hasSelectedPane: true,
      })
    ).toBe(false);
  });
});

describe('resolveSplitView', () => {
  const multiPane = { id: '@1', layout: 'abcd,80x24', panes: [pane('%1'), pane('%2')] };

  test('splits on desktop for a multi-pane window with a layout', () => {
    expect(
      resolveSplitView({ isMobile: false, selectedWindow: multiPane, isSelectionInvalid: false })
    ).toBe(true);
  });

  test('never splits on mobile', () => {
    expect(
      resolveSplitView({ isMobile: true, selectedWindow: multiPane, isSelectionInvalid: false })
    ).toBe(false);
  });

  test('requires a layout string', () => {
    expect(
      resolveSplitView({
        isMobile: false,
        selectedWindow: { id: '@1', panes: [pane('%1'), pane('%2')] },
        isSelectionInvalid: false,
      })
    ).toBe(false);
  });

  test('does not split a single-pane window or an invalid selection', () => {
    expect(
      resolveSplitView({
        isMobile: false,
        selectedWindow: { id: '@1', layout: 'x', panes: [pane('%1')] },
        isSelectionInvalid: false,
      })
    ).toBe(false);
    expect(
      resolveSplitView({ isMobile: false, selectedWindow: multiPane, isSelectionInvalid: true })
    ).toBe(false);
  });
});

describe('resolveStackedLayoutTarget', () => {
  test('targets the multi-pane window on mobile only', () => {
    const window = { id: '@1', panes: [pane('%1'), pane('%2')] };
    expect(resolveStackedLayoutTarget({ isMobile: true, selectedWindow: window })).toBe('@1');
    expect(resolveStackedLayoutTarget({ isMobile: false, selectedWindow: window })).toBeNull();
    expect(
      resolveStackedLayoutTarget({
        isMobile: true,
        selectedWindow: { id: '@1', panes: [pane('%1')] },
      })
    ).toBeNull();
    expect(resolveStackedLayoutTarget({ isMobile: true })).toBeNull();
  });
});

describe('appendRecentSelectRequest', () => {
  test('drops entries older than the ttl and keeps the newest', () => {
    const requests = [
      { windowId: '@1', paneId: '%1', at: 0 },
      { windowId: '@1', paneId: '%2', at: 1500 },
    ];
    expect(
      appendRecentSelectRequest(
        requests,
        { windowId: '@2', paneId: '%3', at: 2000 },
        { ttlMs: 2000, limit: 8 }
      )
    ).toEqual([
      { windowId: '@1', paneId: '%2', at: 1500 },
      { windowId: '@2', paneId: '%3', at: 2000 },
    ]);
  });

  test('caps the buffer at the limit', () => {
    const requests = Array.from({ length: 8 }, (_, index) => ({
      windowId: '@1',
      paneId: `%${index}`,
      at: 100,
    }));
    const next = appendRecentSelectRequest(
      requests,
      { windowId: '@1', paneId: '%new', at: 200 },
      { ttlMs: 2000, limit: 8 }
    );
    expect(next).toHaveLength(8);
    expect(next[0]?.paneId).toBe('%1');
    expect(next.at(-1)?.paneId).toBe('%new');
  });
});

describe('resolveSelectDispatch', () => {
  const base = {
    deviceId: 'd1',
    windowId: '@1',
    paneId: '%2',
    isSplitView: false,
    lastFullSelectWindowKey: null,
    selectedWindowPaneIds: ['%1', '%2'],
  };

  test('skips a route identity that was already dispatched', () => {
    expect(resolveSelectDispatch({ ...base, lastDispatchedKey: 'd1:@1:%2' })).toEqual({
      kind: 'skip',
    });
  });

  test('issues a full select for a new route identity', () => {
    expect(resolveSelectDispatch({ ...base, lastDispatchedKey: null })).toEqual({
      kind: 'select',
      dispatchKey: 'd1:@1:%2',
      fullSelectWindowKey: 'd1:@1',
    });
  });

  test('uses the light focus path inside a split window already fully selected', () => {
    expect(
      resolveSelectDispatch({
        ...base,
        lastDispatchedKey: 'd1:@1:%1',
        isSplitView: true,
        lastFullSelectWindowKey: 'd1:@1',
      })
    ).toEqual({ kind: 'focus', dispatchKey: 'd1:@1:%2' });
  });

  test('falls back to a full select when the window was never fully selected', () => {
    expect(
      resolveSelectDispatch({
        ...base,
        lastDispatchedKey: 'd1:@0:%9',
        isSplitView: true,
        lastFullSelectWindowKey: 'd1:@0',
      })
    ).toEqual({ kind: 'select', dispatchKey: 'd1:@1:%2', fullSelectWindowKey: 'd1:@1' });
  });

  test('falls back to a full select when the pane is not in the snapshot window', () => {
    expect(
      resolveSelectDispatch({
        ...base,
        lastDispatchedKey: null,
        isSplitView: true,
        lastFullSelectWindowKey: 'd1:@1',
        selectedWindowPaneIds: ['%1'],
      })
    ).toEqual({ kind: 'select', dispatchKey: 'd1:@1:%2', fullSelectWindowKey: 'd1:@1' });
  });
});

describe('select size resolution', () => {
  test('derives split select size from the whole terminal area', () => {
    expect(resolveSplitSelectSize({ width: 800, height: 480 }, { width: 10, height: 20 })).toEqual({
      cols: 80,
      rows: 24,
    });
  });

  test('never returns a degenerate split size', () => {
    expect(resolveSplitSelectSize({ width: 5, height: 5 }, { width: 100, height: 100 })).toEqual({
      cols: 2,
      rows: 2,
    });
  });

  test('returns nothing without a measurable rect or cell', () => {
    expect(resolveSplitSelectSize(null, { width: 10, height: 20 })).toBeUndefined();
    expect(resolveSplitSelectSize({ width: 800, height: 480 }, undefined)).toBeUndefined();
    expect(
      resolveSplitSelectSize({ width: 0, height: 480 }, { width: 10, height: 20 })
    ).toBeUndefined();
  });

  test('does not divide by an unmeasured cell size', () => {
    expect(
      resolveSplitSelectSize({ width: 800, height: 480 }, { width: 0, height: 0 })
    ).toBeUndefined();
  });

  test('falls back to the snapshot pane size', () => {
    const windows = [{ id: '@1', panes: [pane('%1', 120, 40)] }];
    expect(resolveSnapshotSelectSize({ windows, windowId: '@1', paneId: '%1' })).toEqual({
      cols: 120,
      rows: 40,
    });
  });

  test('rejects a degenerate snapshot pane size and unknown targets', () => {
    const windows = [{ id: '@1', panes: [pane('%1', 1, 40)] }];
    expect(resolveSnapshotSelectSize({ windows, windowId: '@1', paneId: '%1' })).toBeUndefined();
    expect(resolveSnapshotSelectSize({ windows, windowId: '@1', paneId: '%9' })).toBeUndefined();
    expect(resolveSnapshotSelectSize({ windows, paneId: '%1' })).toBeUndefined();
    expect(
      resolveSnapshotSelectSize({ windows: undefined, windowId: '@1', paneId: '%1' })
    ).toBeUndefined();
  });
});

describe('resolveActivePaneEventFollow', () => {
  const now = 10_000;

  test('follows a genuine active change and records it as handled', () => {
    expect(
      resolveActivePaneEventFollow({
        now,
        activePaneFromEvent: { windowId: '@2', paneId: '%3' },
        currentRoute: { windowId: '@1', paneId: '%1' },
        pendingUserSelection: null,
        recentSelectRequests: [],
        lastHandledActive: null,
      })
    ).toEqual({
      prunedPendingUserSelection: null,
      handledActive: { windowId: '@2', paneId: '%3' },
      clearPendingUserSelection: false,
      follow: { windowId: '@2', paneId: '%3' },
    });
  });

  test('ignores the echo of the pane the route already points at', () => {
    const decision = resolveActivePaneEventFollow({
      now,
      activePaneFromEvent: { windowId: '@1', paneId: '%1' },
      currentRoute: { windowId: '@1', paneId: '%1' },
      pendingUserSelection: null,
      recentSelectRequests: [],
      lastHandledActive: null,
    });
    expect(decision.follow).toBeNull();
    expect(decision.handledActive).toBeNull();
  });

  test('prunes an expired pending user selection', () => {
    const decision = resolveActivePaneEventFollow({
      now,
      activePaneFromEvent: { windowId: '@2', paneId: '%3' },
      currentRoute: { windowId: '@1', paneId: '%1' },
      pendingUserSelection: { windowId: '@3', paneId: '%9', at: 0 },
      recentSelectRequests: [],
      lastHandledActive: null,
    });
    expect(decision.prunedPendingUserSelection).toBeNull();
    expect(decision.follow).toEqual({ windowId: '@2', paneId: '%3' });
  });

  test('clears the pending user selection once the event fulfils it', () => {
    const pending = { windowId: '@2', paneId: '%3', at: now - 100 };
    const decision = resolveActivePaneEventFollow({
      now,
      activePaneFromEvent: { windowId: '@2', paneId: '%3' },
      currentRoute: { windowId: '@1', paneId: '%1' },
      pendingUserSelection: pending,
      recentSelectRequests: [{ windowId: '@2', paneId: '%3', at: now - 100 }],
      lastHandledActive: null,
    });
    expect(decision.clearPendingUserSelection).toBe(true);
    expect(decision.follow).toEqual({ windowId: '@2', paneId: '%3' });
  });

  test('does not re-follow an active it already handled', () => {
    const decision = resolveActivePaneEventFollow({
      now,
      activePaneFromEvent: { windowId: '@2', paneId: '%3' },
      currentRoute: { windowId: '@1', paneId: '%1' },
      pendingUserSelection: null,
      recentSelectRequests: [],
      lastHandledActive: { windowId: '@2', paneId: '%3' },
    });
    expect(decision.follow).toBeNull();
  });
});

describe('resolveSnapshotActiveFollow', () => {
  const now = 10_000;

  test('follows a snapshot active the route does not point at', () => {
    expect(
      resolveSnapshotActiveFollow({
        now,
        snapshotActive: { windowId: '@2', paneId: '%3' },
        currentRoute: { windowId: '@1', paneId: '%1' },
        pendingUserSelection: null,
        recentSelectRequests: [],
        lastSnapshotActive: null,
      })
    ).toEqual({
      prunedPendingUserSelection: null,
      handledActive: { windowId: '@2', paneId: '%3' },
      clearPendingUserSelection: false,
      follow: { windowId: '@2', paneId: '%3' },
    });
  });

  test('records the active but does not navigate when the route already matches', () => {
    const decision = resolveSnapshotActiveFollow({
      now,
      snapshotActive: { windowId: '@1', paneId: '%1' },
      currentRoute: { windowId: '@1', paneId: '%1' },
      pendingUserSelection: null,
      recentSelectRequests: [],
      lastSnapshotActive: null,
    });
    expect(decision.handledActive).toEqual({ windowId: '@1', paneId: '%1' });
    expect(decision.follow).toBeNull();
  });

  test('does not bounce back to a stale active right after a select was sent', () => {
    const decision = resolveSnapshotActiveFollow({
      now,
      snapshotActive: { windowId: '@1', paneId: '%1' },
      currentRoute: { windowId: '@2', paneId: '%3' },
      pendingUserSelection: null,
      recentSelectRequests: [{ windowId: '@2', paneId: '%3', at: now - 100 }],
      lastSnapshotActive: null,
    });
    expect(decision.follow).toBeNull();
    expect(decision.handledActive).toBeNull();
  });

  test('does not re-follow an unchanged snapshot active', () => {
    const decision = resolveSnapshotActiveFollow({
      now,
      snapshotActive: { windowId: '@2', paneId: '%3' },
      currentRoute: { windowId: '@1', paneId: '%1' },
      pendingUserSelection: null,
      recentSelectRequests: [],
      lastSnapshotActive: { windowId: '@2', paneId: '%3' },
    });
    expect(decision.follow).toBeNull();
    expect(decision.handledActive).toBeNull();
  });
});

describe('resolveRemotePaneSizeSync', () => {
  const base = {
    now: 10_000,
    isSplitView: false,
    canInteractWithPane: true,
    isLoading: false,
    remotePane: { width: 100, height: 30 },
    currentSize: { cols: 80, rows: 24 },
    pendingLocalSize: null,
    ttlMs: 2000,
  };

  test('never applies remote sizes in split view', () => {
    expect(resolveRemotePaneSizeSync({ ...base, isSplitView: true })).toEqual({ kind: 'skip' });
  });

  test('skips while loading, uninteractive or without a terminal', () => {
    expect(resolveRemotePaneSizeSync({ ...base, isLoading: true })).toEqual({ kind: 'skip' });
    expect(resolveRemotePaneSizeSync({ ...base, canInteractWithPane: false })).toEqual({
      kind: 'skip',
    });
    expect(resolveRemotePaneSizeSync({ ...base, remotePane: undefined })).toEqual({ kind: 'skip' });
    expect(resolveRemotePaneSizeSync({ ...base, currentSize: null })).toEqual({ kind: 'skip' });
  });

  test('applies and resizes when the remote size differs', () => {
    expect(resolveRemotePaneSizeSync(base)).toEqual({
      kind: 'apply',
      cols: 100,
      rows: 30,
      clearPendingLocalSize: false,
      resize: true,
    });
  });

  test('applies without resizing when sizes already match', () => {
    expect(resolveRemotePaneSizeSync({ ...base, currentSize: { cols: 100, rows: 30 } })).toEqual({
      kind: 'apply',
      cols: 100,
      rows: 30,
      clearPendingLocalSize: false,
      resize: false,
    });
  });

  test('floors and clamps degenerate remote sizes', () => {
    expect(
      resolveRemotePaneSizeSync({ ...base, remotePane: { width: 0, height: 30.9 } })
    ).toMatchObject({ kind: 'apply', cols: 2, rows: 30 });
  });

  test('defers to a pending local resize and schedules a retry past the guard ttl', () => {
    expect(
      resolveRemotePaneSizeSync({
        ...base,
        pendingLocalSize: { cols: 80, rows: 24, at: base.now - 500 },
      })
    ).toEqual({ kind: 'retry', delayMs: 1501 });
  });

  test('clears the pending local size once it is acknowledged by the remote size', () => {
    expect(
      resolveRemotePaneSizeSync({
        ...base,
        pendingLocalSize: { cols: 100, rows: 30, at: base.now - 500 },
      })
    ).toEqual({
      kind: 'apply',
      cols: 100,
      rows: 30,
      clearPendingLocalSize: true,
      resize: true,
    });
  });

  test('stops deferring once the pending local resize outlives the guard ttl', () => {
    expect(
      resolveRemotePaneSizeSync({
        ...base,
        pendingLocalSize: { cols: 80, rows: 24, at: base.now - 5000 },
      })
    ).toMatchObject({ kind: 'apply', clearPendingLocalSize: true, resize: true });
  });
});
