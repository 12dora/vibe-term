import { describe, expect, test } from 'bun:test';
import {
  resolveDeviceDefaultSelection,
  resolvePendingCreateWindowAction,
  resolveRouteTarget,
  resolveSettledMissingWindowFallback,
  resolveSnapshotActiveSelection,
} from './selection-recovery';

const windows = [
  {
    id: '@1',
    active: false,
    panes: [{ id: '%1', active: false }],
  },
  {
    id: '@2',
    active: true,
    panes: [
      { id: '%2', active: false },
      { id: '%3', active: true },
    ],
  },
];

describe('resolveSettledMissingWindowFallback', () => {
  test('keeps an explicit missing route authoritative during the settle grace', () => {
    expect(
      resolveSettledMissingWindowFallback({
        windows,
        routeWindowId: '@999',
        settled: false,
      })
    ).toBeNull();
  });

  test('does not redirect when the route window exists', () => {
    expect(
      resolveSettledMissingWindowFallback({
        windows,
        routeWindowId: '@2',
        settled: true,
      })
    ).toBeNull();
  });

  test('recovers a settled missing window to the active pane', () => {
    expect(
      resolveSettledMissingWindowFallback({
        windows,
        routeWindowId: '@999',
        settled: true,
      })
    ).toEqual({ windowId: '@2', paneId: '%3' });
  });

  test('falls back to the first usable window and pane when active flags are absent', () => {
    expect(
      resolveSettledMissingWindowFallback({
        windows: [
          { id: '@empty', panes: [] },
          { id: '@first', panes: [{ id: '%first' }] },
        ],
        routeWindowId: '@missing',
        settled: true,
      })
    ).toEqual({ windowId: '@first', paneId: '%first' });
  });

  test('returns null when no pane can be selected', () => {
    expect(
      resolveSettledMissingWindowFallback({
        windows: [{ id: '@empty', active: true, panes: [] }],
        routeWindowId: '@missing',
        settled: true,
      })
    ).toBeNull();
  });
});

describe('resolveDeviceDefaultSelection', () => {
  test('selects the active pane only for a device-only route', () => {
    expect(resolveDeviceDefaultSelection({ windows })).toEqual({
      windowId: '@2',
      paneId: '%3',
    });
  });

  test('leaves a window-only route to that window resolver', () => {
    expect(resolveDeviceDefaultSelection({ windows, routeWindowId: '@1' })).toBeNull();
  });

  test('falls back to the first usable device window', () => {
    expect(
      resolveDeviceDefaultSelection({
        windows: [
          { id: '@empty', panes: [] },
          { id: '@first', panes: [{ id: '%first' }] },
        ],
      })
    ).toEqual({ windowId: '@first', paneId: '%first' });
  });
});

describe('resolveRouteTarget', () => {
  test('leaves the device when every window is gone', () => {
    expect(
      resolveRouteTarget({
        windows: [],
        routeWindowId: '@2',
        routePaneId: '%3',
        settledMissing: true,
      })
    ).toEqual({ kind: 'leave-device' });
  });

  test('stays while a missing route window is still within the settle grace', () => {
    expect(
      resolveRouteTarget({
        windows,
        routeWindowId: '@999',
        routePaneId: '%999',
        settledMissing: false,
      })
    ).toEqual({ kind: 'stay' });
  });

  test('recovers a settled missing window to the snapshot active pane', () => {
    expect(
      resolveRouteTarget({
        windows,
        routeWindowId: '@999',
        routePaneId: '%999',
        settledMissing: true,
      })
    ).toEqual({ kind: 'navigate', windowId: '@2', paneId: '%3' });
  });

  test('completes a window-only route with the active pane', () => {
    expect(resolveRouteTarget({ windows, routeWindowId: '@2', settledMissing: false })).toEqual({
      kind: 'navigate',
      windowId: '@2',
      paneId: '%3',
    });
  });

  test('stays when the routed pane is present', () => {
    expect(
      resolveRouteTarget({
        windows,
        routeWindowId: '@2',
        routePaneId: '%2',
        settledMissing: true,
      })
    ).toEqual({ kind: 'stay' });
  });

  test('follows a pane that was moved to another window', () => {
    expect(
      resolveRouteTarget({
        windows,
        routeWindowId: '@2',
        routePaneId: '%1',
        settledMissing: false,
      })
    ).toEqual({ kind: 'navigate', windowId: '@1', paneId: '%1' });
  });

  test('keeps a not-yet-visible pane during the settle grace', () => {
    expect(
      resolveRouteTarget({
        windows,
        routeWindowId: '@2',
        routePaneId: '%404',
        settledMissing: false,
      })
    ).toEqual({ kind: 'stay' });
  });

  test('falls back to the window active pane once the missing pane settles', () => {
    expect(
      resolveRouteTarget({
        windows,
        routeWindowId: '@2',
        routePaneId: '%404',
        settledMissing: true,
      })
    ).toEqual({ kind: 'navigate', windowId: '@2', paneId: '%3' });
  });

  test('stays when the routed window has no pane to fall back to', () => {
    expect(
      resolveRouteTarget({
        windows: [{ id: '@empty', active: true, panes: [] }],
        routeWindowId: '@empty',
        routePaneId: '%404',
        settledMissing: true,
      })
    ).toEqual({ kind: 'stay' });
  });
});

describe('resolveSnapshotActiveSelection', () => {
  test('reads the active pane of the active window', () => {
    expect(resolveSnapshotActiveSelection(windows)).toEqual({ windowId: '@2', paneId: '%3' });
  });

  test('returns null without a snapshot', () => {
    expect(resolveSnapshotActiveSelection(undefined)).toBeNull();
    expect(resolveSnapshotActiveSelection([])).toBeNull();
  });

  test('returns null when the active window has no active pane', () => {
    expect(
      resolveSnapshotActiveSelection([{ id: '@1', active: true, panes: [{ id: '%1' }] }])
    ).toBeNull();
  });
});

describe('resolvePendingCreateWindowAction', () => {
  const snapshotActive = { windowId: '@2', paneId: '%3' };

  test('clears an expired pending create', () => {
    expect(
      resolvePendingCreateWindowAction({
        pendingAt: 0,
        now: 5001,
        ttlMs: 5000,
        snapshotActive,
        routeWindowId: '@1',
        routePaneId: '%1',
      })
    ).toEqual({ kind: 'clear' });
  });

  test('defers until a snapshot arrives', () => {
    expect(
      resolvePendingCreateWindowAction({
        pendingAt: 1000,
        now: 2000,
        ttlMs: 5000,
        snapshotActive: null,
        routeWindowId: '@1',
        routePaneId: '%1',
      })
    ).toEqual({ kind: 'defer', delayMs: 4000 });
  });

  test('defers when the route already points at the new window', () => {
    expect(
      resolvePendingCreateWindowAction({
        pendingAt: 1000,
        now: 2000,
        ttlMs: 5000,
        snapshotActive,
        routeWindowId: '@2',
        routePaneId: '%3',
      })
    ).toEqual({ kind: 'defer', delayMs: 4000 });
  });

  test('follows the snapshot active once it differs from the route', () => {
    expect(
      resolvePendingCreateWindowAction({
        pendingAt: 1000,
        now: 2000,
        ttlMs: 5000,
        snapshotActive,
        routeWindowId: '@1',
        routePaneId: '%1',
      })
    ).toEqual({ kind: 'follow', windowId: '@2', paneId: '%3' });
  });
});
