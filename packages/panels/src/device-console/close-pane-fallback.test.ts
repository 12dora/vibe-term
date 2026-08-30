import { describe, expect, test } from 'bun:test';
import { resolveCloseFallback } from './close-pane-fallback';
import type { SelectionWindowLike } from './selection-recovery';

function window(
  id: string,
  panes: Array<{ id: string; active?: boolean }>,
  active = false
): SelectionWindowLike {
  return { id, active, panes };
}

const base = {
  routeWindowId: '@1',
  routePaneId: '%1',
  closingWindowId: '@1',
  closingPaneId: '%1',
};

describe('resolveCloseFallback', () => {
  test('closing a pane the route does not point at needs no navigation', () => {
    expect(
      resolveCloseFallback({
        ...base,
        closingPaneId: '%2',
        windows: [window('@1', [{ id: '%1' }, { id: '%2' }])],
      })
    ).toEqual({ kind: 'none' });
  });

  test('closing a pane in another window needs no navigation', () => {
    expect(
      resolveCloseFallback({
        ...base,
        closingWindowId: '@2',
        windows: [window('@1', [{ id: '%1' }]), window('@2', [{ id: '%1' }])],
      })
    ).toEqual({ kind: 'none' });
  });

  test('falls back to the tmux active pane of the same window', () => {
    expect(
      resolveCloseFallback({
        ...base,
        windows: [
          window('@1', [{ id: '%1', active: true }, { id: '%2' }, { id: '%3', active: true }]),
        ],
      })
    ).toEqual({ kind: 'pane', windowId: '@1', paneId: '%3' });
  });

  test('falls back to the first remaining pane when the active one is being closed', () => {
    expect(
      resolveCloseFallback({
        ...base,
        windows: [window('@1', [{ id: '%1', active: true }, { id: '%2' }, { id: '%3' }])],
      })
    ).toEqual({ kind: 'pane', windowId: '@1', paneId: '%2' });
  });

  test('falls back to the active pane of the active window when the window empties out', () => {
    expect(
      resolveCloseFallback({
        ...base,
        windows: [
          window('@1', [{ id: '%1', active: true }]),
          window('@2', [{ id: '%8' }]),
          window('@3', [{ id: '%9' }, { id: '%10', active: true }], true),
        ],
      })
    ).toEqual({ kind: 'pane', windowId: '@3', paneId: '%10' });
  });

  test('falls back to the first other window when none is marked active', () => {
    expect(
      resolveCloseFallback({
        ...base,
        windows: [window('@1', [{ id: '%1' }]), window('@2', [{ id: '%8' }])],
      })
    ).toEqual({ kind: 'pane', windowId: '@2', paneId: '%8' });
  });

  test('leaves for the device list when nothing remains', () => {
    expect(resolveCloseFallback({ ...base, windows: [window('@1', [{ id: '%1' }])] })).toEqual({
      kind: 'device-list',
    });
    expect(resolveCloseFallback({ ...base, windows: [] })).toEqual({ kind: 'device-list' });
    expect(resolveCloseFallback({ ...base, windows: undefined })).toEqual({ kind: 'device-list' });
  });

  test('ignores a route without a pane', () => {
    expect(
      resolveCloseFallback({
        ...base,
        routePaneId: undefined,
        windows: [window('@1', [{ id: '%1' }, { id: '%2' }])],
      })
    ).toEqual({ kind: 'none' });
  });
});
