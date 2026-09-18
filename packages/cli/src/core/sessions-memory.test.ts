import { describe, expect, test } from 'bun:test';
import type { TmuxSession } from '@vibeterm/shared';
import {
  applyMemorySample,
  deviceIsConnected,
  mapPool,
  waitForWindowMemory,
  windowMemoryCollectTimeoutMs,
  windowsFromTree,
} from './sessions-memory';

const TREE: TmuxSession = {
  id: '$0',
  name: 'main',
  windows: [
    {
      id: '@1',
      name: 'build',
      index: 0,
      active: true,
      panes: [
        { id: '%0', windowId: '@1', index: 0, active: true, width: 80, height: 24 },
        { id: '%1', windowId: '@1', index: 1, active: false, width: 80, height: 24 },
      ],
    },
  ],
};

describe('deviceIsConnected', () => {
  test('uses the explicit connected field when present', () => {
    const base = {
      deviceId: 'a',
      deviceName: 'a',
      windows: [] as never[],
      limitsSupported: null as boolean | null,
    };
    expect(deviceIsConnected({ ...base, supported: false, connected: true })).toBe(true);
    expect(deviceIsConnected({ ...base, supported: true, connected: false })).toBe(false);
  });

  test('infers connected from windows or supported when the field is missing', () => {
    const base = { deviceId: 'a', deviceName: 'a', limitsSupported: null as boolean | null };
    expect(deviceIsConnected({ ...base, supported: false, windows: [] })).toBe(false);
    expect(deviceIsConnected({ ...base, supported: true, windows: [] })).toBe(true);
    expect(
      deviceIsConnected({
        ...base,
        supported: false,
        windows: [{ windowId: '@1' } as never],
      })
    ).toBe(true);
  });
});

describe('windowMemoryCollectTimeoutMs', () => {
  test('is 2×interval + 3s', () => {
    expect(windowMemoryCollectTimeoutMs(5)).toBe(13_000);
    expect(windowMemoryCollectTimeoutMs(2)).toBe(7_000);
  });
});

describe('windowsFromTree / applyMemorySample', () => {
  test('copies window ids and pane counts with zeroed memory fields and no source', () => {
    const windows = windowsFromTree(TREE);
    expect(windows).toEqual([
      {
        windowId: '@1',
        windowName: 'build',
        panes: 2,
        scopes: [],
        current: 0,
        high: 0,
        max: 0,
        swapMax: 0,
        oomKills: 0,
        oomFlag: false,
        sampledAt: 0,
      },
    ]);
    expect(windows[0].source).toBeUndefined();
    expect(JSON.parse(JSON.stringify(windows[0]))).not.toHaveProperty('source');
    const merged = applyMemorySample(windows[0], {
      type: 'window-memory',
      deviceId: 'dev',
      windowId: '@1',
      current: 99,
      high: 1,
      max: 2,
      swapMax: 3,
      oomKills: 4,
      oomFlag: true,
      panes: 2,
      sampledAt: 8,
      source: 'rss',
    });
    expect(merged.current).toBe(99);
    expect(merged.oomFlag).toBe(true);
    expect(merged.sampledAt).toBe(8);
    expect(merged.source).toBe('rss');
  });

  test('unsampled windows stay sourceless so JSON cannot claim cgroup', () => {
    const tree: TmuxSession = {
      ...TREE,
      windows: [
        TREE.windows[0],
        {
          id: '@2',
          name: 'dead',
          index: 1,
          active: false,
          panes: [{ id: '%2', windowId: '@2', index: 0, active: true, width: 80, height: 24 }],
        },
      ],
    };
    const windows = windowsFromTree(tree);
    const merged = [
      applyMemorySample(windows[0], {
        type: 'window-memory',
        deviceId: 'dev',
        windowId: '@1',
        current: 4096,
        high: 0,
        max: 0,
        swapMax: 0,
        oomKills: 0,
        oomFlag: false,
        panes: 2,
        sampledAt: 9,
        source: 'rss',
      }),
      windows[1],
    ];
    expect(merged[0].source).toBe('rss');
    expect(merged[0].sampledAt).toBe(9);
    expect(merged[1].sampledAt).toBe(0);
    expect(merged[1].source).toBeUndefined();
    expect(JSON.parse(JSON.stringify(merged[1]))).not.toHaveProperty('source');
  });
});

describe('waitForWindowMemory', () => {
  test('resolves immediately when every window already has a sample', async () => {
    const samples = new Map([['@1', true]]);
    let attached = false;
    await waitForWindowMemory(
      ['@1'],
      samples,
      () => {
        attached = true;
      },
      50
    );
    expect(attached).toBe(false);
  });

  test('resolves when a sample arrives, or on timeout', async () => {
    const samples = new Map<string, boolean>();
    let notify = (): void => {};
    const pending = waitForWindowMemory(
      ['@1'],
      samples,
      (next) => {
        notify = next;
      },
      200
    );
    samples.set('@1', true);
    notify();
    await pending;

    const slow = new Map<string, boolean>();
    const started = Date.now();
    await waitForWindowMemory(['@9'], slow, () => {}, 20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});

describe('mapPool', () => {
  test('caps concurrency', async () => {
    let live = 0;
    let max = 0;
    const order: number[] = [];
    await mapPool([1, 2, 3, 4, 5], 2, async (item) => {
      live += 1;
      max = Math.max(max, live);
      order.push(item);
      await new Promise((resolve) => setTimeout(resolve, 10));
      live -= 1;
      return item;
    });
    expect(max).toBeLessThanOrEqual(2);
    expect(order.sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
