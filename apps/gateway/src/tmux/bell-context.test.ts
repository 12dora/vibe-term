import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import { resolvePaneContext } from './bell-context';

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

  test('unmatched paneId with windowId uses that window active pane', () => {
    const bell = resolvePaneContext({
      deviceId: 'device-1',
      siteUrl: 'https://tmex.example.com',
      snapshot: createSnapshot(),
      rawData: {
        windowId: '@1',
        paneId: '%missing',
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

  test('unmatched paneId without windowId uses the active window pane', () => {
    const bell = resolvePaneContext({
      deviceId: 'device-1',
      siteUrl: 'https://tmex.example.com',
      snapshot: createSnapshot(),
      rawData: {
        paneId: '%missing',
      },
    });

    expect(bell.paneId).toBe('%21');
    expect(bell.windowId).toBe('@2');
  });

  test('falls back to the first window when none is active', () => {
    const snapshot = createSnapshot();
    for (const window of snapshot.session?.windows ?? []) {
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

  test('empty session windows keep raw ids and omit pane url', () => {
    const bell = resolvePaneContext({
      deviceId: 'device-1',
      siteUrl: 'https://tmex.example.com',
      snapshot: {
        deviceId: 'device-1',
        session: { id: '$1', name: 'tmex', windows: [] },
      },
      rawData: { windowId: '@9', paneId: '%99' },
    });

    expect(bell).toEqual({
      windowId: '@9',
      paneId: '%99',
      windowIndex: undefined,
      paneIndex: undefined,
      paneUrl: undefined,
      paneTitle: undefined,
      paneCurrentCommand: undefined,
    });
  });
});
