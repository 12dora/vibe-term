import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload, TmuxPane, TmuxWindow } from '@tmex/shared';
import { buildContext, findPane, resolvePaneContext, resolveWindowTitle } from './bell-context';

function createSnapshot(): StateSnapshotPayload {
  return {
    deviceId: 'device-1',
    session: {
      id: '$1',
      name: 'tmex',
      windows: [
        {
          id: '@1',
          name: 'dev',
          index: 0,
          active: false,
          panes: [
            {
              id: '%11',
              windowId: '@1',
              index: 0,
              title: 'first',
              active: false,
              width: 80,
              height: 24,
            },
            {
              id: '%12',
              windowId: '@1',
              index: 1,
              title: 'second',
              currentCommand: 'vim',
              active: true,
              width: 80,
              height: 24,
            },
          ],
        },
        {
          id: '@2',
          name: 'ops',
          index: 1,
          active: true,
          panes: [
            {
              id: '%21',
              windowId: '@2',
              index: 0,
              title: 'ops-1',
              currentCommand: 'htop',
              active: true,
              width: 120,
              height: 30,
            },
          ],
        },
      ],
    },
  };
}

describe('resolvePaneContext', () => {
  test('resolves by paneId first and builds pane url', () => {
    const bell = resolvePaneContext({
      deviceId: 'device-1',
      siteUrl: 'https://tmex.example.com/',
      snapshot: createSnapshot(),
      rawData: {
        paneId: '%12',
      },
    });

    expect(bell).toEqual({
      windowId: '@1',
      paneId: '%12',
      windowIndex: 0,
      paneIndex: 1,
      paneUrl: 'https://tmex.example.com/devices/device-1/windows/%401/panes/%2512',
      paneTitle: 'second',
      paneCurrentCommand: 'vim',
    });
  });

  test('falls back to active window/pane when raw data is empty', () => {
    const bell = resolvePaneContext({
      deviceId: 'device-1',
      siteUrl: 'https://tmex.example.com',
      snapshot: createSnapshot(),
      rawData: {},
    });

    expect(bell).toEqual({
      windowId: '@2',
      paneId: '%21',
      windowIndex: 1,
      paneIndex: 0,
      paneUrl: 'https://tmex.example.com/devices/device-1/windows/%402/panes/%2521',
      paneTitle: 'ops-1',
      paneCurrentCommand: 'htop',
    });
  });

  test('returns raw ids when snapshot is unavailable', () => {
    const bell = resolvePaneContext({
      deviceId: 'device-1',
      siteUrl: 'https://tmex.example.com',
      snapshot: null,
      rawData: {
        windowId: '@1',
        paneId: '%12',
      },
    });

    expect(bell).toEqual({
      windowId: '@1',
      paneId: '%12',
    });
  });

  test('falls back to windowId when paneId is missing from the snapshot', () => {
    const bell = resolvePaneContext({
      deviceId: 'device-1',
      siteUrl: 'https://tmex.example.com',
      snapshot: createSnapshot(),
      rawData: {
        windowId: '@1',
        paneId: '%missing',
      },
    });

    expect(bell.windowId).toBe('@1');
    expect(bell.paneId).toBe('%12');
    expect(bell.windowIndex).toBe(0);
    expect(bell.paneIndex).toBe(1);
    expect(bell.paneTitle).toBe('second');
  });

  test('uses the first window when none is active', () => {
    const snapshot = createSnapshot();
    if (!snapshot.session) {
      throw new Error('expected session');
    }
    for (const window of snapshot.session.windows) {
      window.active = false;
    }

    const bell = resolvePaneContext({
      deviceId: 'device-1',
      siteUrl: 'https://tmex.example.com',
      snapshot,
      rawData: {},
    });

    expect(bell.windowId).toBe('@1');
    expect(bell.paneId).toBe('%12');
  });

  test('uses the first pane when the target window has no active pane', () => {
    const snapshot = createSnapshot();
    const window = snapshot.session?.windows[0];
    if (!window) {
      throw new Error('expected window');
    }
    for (const pane of window.panes) {
      pane.active = false;
    }

    const bell = resolvePaneContext({
      deviceId: 'device-1',
      siteUrl: 'https://tmex.example.com',
      snapshot,
      rawData: { windowId: '@1' },
    });

    expect(bell.windowId).toBe('@1');
    expect(bell.paneId).toBe('%11');
    expect(bell.paneTitle).toBe('first');
  });

  test('keeps raw ids when the session has no windows', () => {
    const bell = resolvePaneContext({
      deviceId: 'device-1',
      siteUrl: 'https://tmex.example.com',
      snapshot: { deviceId: 'device-1', session: { id: '$1', name: 'tmex', windows: [] } },
      rawData: { windowId: '@9', paneId: '%9' },
    });

    expect(bell).toEqual({
      windowId: '@9',
      paneId: '%9',
      windowIndex: undefined,
      paneIndex: undefined,
      paneUrl: undefined,
      paneTitle: undefined,
      paneCurrentCommand: undefined,
    });
  });

  test('treats empty and non-string raw ids as missing', () => {
    const bell = resolvePaneContext({
      deviceId: 'device-1',
      siteUrl: 'https://tmex.example.com',
      snapshot: createSnapshot(),
      rawData: { windowId: '', paneId: 12 },
    });

    expect(bell.windowId).toBe('@2');
    expect(bell.paneId).toBe('%21');
  });
});

describe('findPane', () => {
  test('returns the owning window and pane', () => {
    const windows = createSnapshot().session?.windows ?? [];
    expect(findPane(windows, '%21')).toEqual({
      window: windows[1],
      pane: windows[1]?.panes[0],
    });
  });

  test('returns null when the pane id is missing or unknown', () => {
    const windows = createSnapshot().session?.windows ?? [];
    expect(findPane(windows, undefined)).toBeNull();
    expect(findPane(windows, '%missing')).toBeNull();
  });
});

describe('resolveWindowTitle', () => {
  test('prefers the matched window, then windowId, then active, then first', () => {
    const windows = createSnapshot().session?.windows ?? [];
    const first = windows[0];
    const second = windows[1];
    if (!first || !second) {
      throw new Error('expected windows');
    }

    expect(resolveWindowTitle(windows, { matchedWindow: first })).toBe(first);
    expect(resolveWindowTitle(windows, { windowId: '@1' })).toBe(first);
    expect(resolveWindowTitle(windows, {})).toBe(second);

    second.active = false;
    expect(resolveWindowTitle(windows, { windowId: '@missing' })).toBe(first);
    expect(resolveWindowTitle([], {})).toBeUndefined();
  });
});

describe('buildContext', () => {
  const window: TmuxWindow = {
    id: '@1',
    name: 'dev',
    index: 3,
    active: true,
    panes: [],
  };
  const pane: TmuxPane = {
    id: '%12',
    windowId: '@1',
    index: 7,
    title: 'nvim',
    currentCommand: 'nvim',
    active: true,
    width: 80,
    height: 24,
  };

  test('builds pane url and copies indexes from the resolved pane', () => {
    expect(
      buildContext({
        deviceId: 'device-1',
        siteUrl: 'https://tmex.example.com/',
        window,
        pane,
      })
    ).toEqual({
      windowId: '@1',
      paneId: '%12',
      windowIndex: 3,
      paneIndex: 7,
      paneUrl: 'https://tmex.example.com/devices/device-1/windows/%401/panes/%2512',
      paneTitle: 'nvim',
      paneCurrentCommand: 'nvim',
    });
  });

  test('falls back to raw ids when window or pane is missing', () => {
    expect(
      buildContext({
        deviceId: 'device-1',
        siteUrl: 'https://tmex.example.com',
        fallbackWindowId: '@raw',
        fallbackPaneId: '%raw',
      })
    ).toEqual({
      windowId: '@raw',
      paneId: '%raw',
      windowIndex: undefined,
      paneIndex: undefined,
      paneUrl: undefined,
      paneTitle: undefined,
      paneCurrentCommand: undefined,
    });
  });
});
