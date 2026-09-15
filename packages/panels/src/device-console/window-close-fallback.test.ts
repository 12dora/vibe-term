import { describe, expect, test } from 'bun:test';
import type { SelectionWindowLike } from './selection-recovery';
import { resolveWindowCloseFallback } from './window-close-fallback';

function window(
  id: string,
  panes: Array<{ id: string; active?: boolean }>,
  active = false
): SelectionWindowLike {
  return { id, active, panes };
}

const base = { routeWindowId: '@1', closingWindowId: '@1' };

describe('resolveWindowCloseFallback', () => {
  test('closing a window the route does not point at needs no navigation', () => {
    expect(
      resolveWindowCloseFallback({
        ...base,
        closingWindowId: '@2',
        windows: [window('@1', [{ id: '%1' }]), window('@2', [{ id: '%2' }])],
      })
    ).toEqual({ kind: 'none' });
  });

  test('ignores a route without a window', () => {
    expect(
      resolveWindowCloseFallback({
        ...base,
        routeWindowId: undefined,
        windows: [window('@1', [{ id: '%1' }]), window('@2', [{ id: '%2' }])],
      })
    ).toEqual({ kind: 'none' });
  });

  test('falls back to the active pane of the tmux active window', () => {
    expect(
      resolveWindowCloseFallback({
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
      resolveWindowCloseFallback({
        ...base,
        windows: [window('@1', [{ id: '%1' }]), window('@2', [{ id: '%8' }, { id: '%9' }])],
      })
    ).toEqual({ kind: 'pane', windowId: '@2', paneId: '%8' });
  });

  test('skips windows that have no pane left', () => {
    expect(
      resolveWindowCloseFallback({
        ...base,
        windows: [
          window('@1', [{ id: '%1' }]),
          window('@2', [], true),
          window('@3', [{ id: '%9' }]),
        ],
      })
    ).toEqual({ kind: 'pane', windowId: '@3', paneId: '%9' });
  });

  test('leaves for the device list when the closed window is the last one', () => {
    expect(
      resolveWindowCloseFallback({ ...base, windows: [window('@1', [{ id: '%1' }])] })
    ).toEqual({ kind: 'device-list' });
    expect(resolveWindowCloseFallback({ ...base, windows: [] })).toEqual({ kind: 'device-list' });
    expect(resolveWindowCloseFallback({ ...base, windows: undefined })).toEqual({
      kind: 'device-list',
    });
  });
});
