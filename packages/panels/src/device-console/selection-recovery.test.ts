import { describe, expect, test } from 'bun:test';
import {
  resolveDeviceDefaultSelection,
  resolveSettledMissingWindowFallback,
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
