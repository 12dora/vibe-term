import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { WINDOW_MEMORY_SETTINGS_DEFAULTS } from '@vibeterm/shared';
import { runMigrations } from '../db/migrate';
import type { TmuxConnectionOptions } from '../tmux-client/connection-types';
import { createDeviceSessionRuntime } from '../tmux-client/device-session-runtime';
import { resetWindowOomMarkStoreForTests } from './oom-mark-store';
import { createWindowMemoryRuntimeAdapter, formatWindowOomKillWarn } from './runtime-adapter';
import { resetWindowMemorySettingsStoreForTests } from './settings-store';
import type { WindowMemoryAggregate, WindowMemoryTracker, WindowOomKillEvent } from './types';

beforeAll(() => {
  runMigrations();
});

function aggregate(windowId = '@1'): WindowMemoryAggregate {
  return {
    windowId,
    windowName: 'main',
    panes: 1,
    scopes: ['tmux-spawn-aaa.scope'],
    current: 1024,
    high: 8192,
    max: 12288,
    swapMax: 4096,
    oomKills: 0,
    oomFlag: false,
    sampledAt: 1_700_000_000_000,
  };
}

describe('createWindowMemoryRuntimeAdapter', () => {
  test('无 tracker 时 getWindows 回 []，tick 立即完成', async () => {
    const adapter = createWindowMemoryRuntimeAdapter(() => ({}));
    expect(adapter.getWindows()).toEqual([]);
    expect(adapter.supported()).toBeNull();
    await adapter.tick();
  });

  test('走 connection.windowMemory 的 getWindows/supported/tick', async () => {
    const ticks: number[] = [];
    const tracker: WindowMemoryTracker = {
      supported: true,
      start() {},
      stop() {},
      async tick() {
        ticks.push(1);
      },
      getWindows: () => [aggregate('@2')],
      async stopScopesForWindow() {},
      async stopScopesForPane() {},
    };
    const adapter = createWindowMemoryRuntimeAdapter(() => ({ windowMemory: tracker }));
    expect(adapter.getWindows()).toEqual([aggregate('@2')]);
    expect(adapter.supported()).toBe(true);
    await adapter.tick();
    expect(ticks).toEqual([1]);
  });

  test('onSample 扇出给订阅者；onOomKill 打 warn 且不经 store', () => {
    resetWindowMemorySettingsStoreForTests();
    resetWindowOomMarkStoreForTests();
    const adapter = createWindowMemoryRuntimeAdapter(() => ({}));
    const seen: WindowMemoryAggregate[][] = [];
    const off = adapter.subscribe((windows) => {
      seen.push(windows);
    });
    adapter.hooks.onSample([aggregate()]);
    expect(seen).toHaveLength(1);
    off();
    adapter.hooks.onSample([aggregate('@9')]);
    expect(seen).toHaveLength(1);

    const event: WindowOomKillEvent = {
      deviceId: 'dev-a',
      windowId: '@1',
      paneId: '%3',
      scope: 'tmux-spawn-aaa.scope',
      oomKills: 2,
      current: 10,
      high: 20,
      max: 30,
    };
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      adapter.hooks.onOomKill(event);
      expect(warn).toHaveBeenCalledWith(formatWindowOomKillWarn(event));
    } finally {
      warn.mockRestore();
    }
    expect(adapter.hooks.getSettings()).toEqual(WINDOW_MEMORY_SETTINGS_DEFAULTS);
  });

  test('DeviceSessionRuntime 把 hooks 注入 createConnection，并暴露 get/on/tick', async () => {
    resetWindowMemorySettingsStoreForTests();
    resetWindowOomMarkStoreForTests();
    const captured: { options: TmuxConnectionOptions | null } = { options: null };
    const windows = [aggregate('@4')];
    const tracker: WindowMemoryTracker = {
      supported: false,
      start() {},
      stop() {},
      async tick() {},
      getWindows: () => windows,
      async stopScopesForWindow() {},
      async stopScopesForPane() {},
    };
    const runtime = createDeviceSessionRuntime({
      deviceId: 'device-a',
      createConnection(options) {
        captured.options = options;
        return { windowMemory: tracker, disconnect() {} } as never;
      },
    });
    const hooks = captured.options?.windowMemory;
    expect(hooks?.getSettings()).toEqual(WINDOW_MEMORY_SETTINGS_DEFAULTS);
    expect(runtime.getWindowMemory()).toEqual(windows);
    expect(runtime.getWindowMemorySupported()).toBe(false);
    const seen: WindowMemoryAggregate[][] = [];
    const off = runtime.onWindowMemory((next) => {
      seen.push(next);
    });
    hooks?.onSample(windows);
    expect(seen).toEqual([windows]);
    off();
    await runtime.tickWindowMemory();
    runtime.disconnect();
  });
});
