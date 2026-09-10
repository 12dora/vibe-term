// tmux store → 拓扑缓存写通与占位对账的用例（缓存本体的用例在 tmux-topology-cache.test.ts）。

import { beforeEach, describe, expect, test } from 'bun:test';
import type { TmuxPane, TmuxSession, TmuxWindow } from '@vibeterm/shared';
import { createMemoryStorage } from './test-utils';
import {
  TOPOLOGY_WRITE_INTERVAL_MS,
  type TmuxTopologyPlaceholders,
  readTmuxTopologyCache,
} from './tmux-topology-cache';
import {
  type TopologySyncState,
  type TopologySyncStore,
  type TopologySyncTimers,
  syncTmuxTopologyCache,
} from './tmux-topology-sync';

const PREFIX = 'n:sync-test:';

function pane(id: string, overrides: Partial<TmuxPane> = {}): TmuxPane {
  return { id, windowId: '@1', index: 0, active: true, width: 80, height: 24, ...overrides };
}

function tmuxWindow(
  id: string,
  panes: TmuxPane[],
  overrides: Partial<TmuxWindow> = {}
): TmuxWindow {
  return { id, name: 'zsh', index: 0, active: true, panes, ...overrides };
}

function session(windows: TmuxWindow[]): TmuxSession {
  return { id: '$0', name: 'main', windows };
}

let storage = createMemoryStorage();

beforeEach(() => {
  storage = createMemoryStorage();
});

/** 记账用 Storage：句柄按存储实例缓存，每个用例换一份即天然隔离 */
function countingStorage() {
  const inner = createMemoryStorage();
  let writes = 0;
  return {
    getItem: (key: string) => inner.getItem(key),
    setItem: (key: string, value: string) => {
      writes += 1;
      inner.setItem(key, value);
    },
    removeItem: (key: string) => inner.removeItem(key),
    get writes() {
      return writes;
    },
  };
}

class FakeTimers implements TopologySyncTimers {
  private seq = 0;
  private readonly jobs = new Map<number, () => void>();

  setTimer(fn: () => void): unknown {
    this.seq += 1;
    this.jobs.set(this.seq, fn);
    return this.seq;
  }

  clearTimer(handle: unknown): void {
    this.jobs.delete(handle as number);
  }

  runAll(): void {
    const pending = [...this.jobs.entries()];
    this.jobs.clear();
    for (const [, fn] of pending) fn();
  }

  get pendingCount(): number {
    return this.jobs.size;
  }
}

function createFakeStore(initial: Partial<TopologySyncState> = {}) {
  const listeners = new Set<() => void>();
  let state: TopologySyncState = {
    snapshots: {},
    connectedDevices: new Set<string>(),
    topologyPlaceholders: {},
    ...initial,
  };
  const store: TopologySyncStore = {
    getState: () => state,
    setState: (partial) => {
      state = { ...state, ...partial };
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    store,
    patch(partial: Partial<TopologySyncState>) {
      state = { ...state, ...partial };
      for (const listener of [...listeners]) listener();
    },
    get current() {
      return state;
    },
  };
}

describe('syncTmuxTopologyCache', () => {
  test('快照变化写通到缓存，并按每设备 1 次/秒节流', () => {
    const timers = new FakeTimers();
    let now = 10_000;
    const fake = createFakeStore();
    const dispose = syncTmuxTopologyCache(fake.store, {
      storagePrefix: PREFIX,
      storage,
      now: () => now,
      timers,
    });

    fake.patch({
      snapshots: { 'dev-1': { session: session([tmuxWindow('@1', [pane('%1')])]) } },
    });
    expect(readTmuxTopologyCache(PREFIX, storage, now)['dev-1']?.windows).toHaveLength(1);

    // 同一秒内的第二次变化只排队，不再落盘
    now += 100;
    fake.patch({
      snapshots: {
        'dev-1': {
          session: session([tmuxWindow('@1', [pane('%1')]), tmuxWindow('@2', [pane('%2')])]),
        },
      },
    });
    expect(readTmuxTopologyCache(PREFIX, storage, now)['dev-1']?.windows).toHaveLength(1);
    expect(timers.pendingCount).toBe(1);

    now += TOPOLOGY_WRITE_INTERVAL_MS;
    timers.runAll();
    expect(readTmuxTopologyCache(PREFIX, storage, now)['dev-1']?.windows).toHaveLength(2);

    dispose();
  });

  test('设备退出 connectedDevices 即删掉它的缓存与占位', () => {
    const timers = new FakeTimers();
    let now = 0;
    const placeholders: TmuxTopologyPlaceholders = {
      'dev-2': {
        savedAt: 0,
        windows: [{ id: '@9', index: 0, name: 'zsh', active: true, panes: [] }],
      },
    };
    const fake = createFakeStore({
      connectedDevices: new Set(['dev-1', 'dev-2']),
      topologyPlaceholders: placeholders,
    });
    const dispose = syncTmuxTopologyCache(fake.store, {
      storagePrefix: PREFIX,
      storage,
      now: () => now,
      timers,
    });

    fake.patch({ snapshots: { 'dev-1': { session: session([tmuxWindow('@1', [pane('%1')])]) } } });
    expect(readTmuxTopologyCache(PREFIX, storage, now)['dev-1']).toBeDefined();

    now += TOPOLOGY_WRITE_INTERVAL_MS;
    fake.patch({ connectedDevices: new Set(['dev-1']) });
    expect(fake.current.topologyPlaceholders['dev-2']).toBeUndefined();

    fake.patch({ connectedDevices: new Set<string>() });
    expect(readTmuxTopologyCache(PREFIX, storage, now)['dev-1']).toBeUndefined();

    dispose();
  });

  test('实时快照到货即摘掉该设备的占位，其余占位保留', () => {
    const timers = new FakeTimers();
    const fake = createFakeStore({
      topologyPlaceholders: {
        'dev-1': {
          savedAt: 0,
          windows: [{ id: '@1', index: 0, name: 'zsh', active: true, panes: [] }],
        },
        'dev-2': {
          savedAt: 0,
          windows: [{ id: '@2', index: 0, name: 'zsh', active: true, panes: [] }],
        },
      },
    });
    const dispose = syncTmuxTopologyCache(fake.store, {
      storagePrefix: PREFIX,
      storage,
      now: () => 0,
      timers,
    });

    fake.patch({ snapshots: { 'dev-1': { session: session([tmuxWindow('@1', [pane('%1')])]) } } });

    expect(fake.current.topologyPlaceholders['dev-1']).toBeUndefined();
    expect(fake.current.topologyPlaceholders['dev-2']).toBeDefined();

    dispose();
  });

  test('dispose 会把在途的节流写入落盘，并停止订阅', () => {
    const timers = new FakeTimers();
    let now = 0;
    const fake = createFakeStore();
    const dispose = syncTmuxTopologyCache(fake.store, {
      storagePrefix: PREFIX,
      storage,
      now: () => now,
      timers,
    });

    fake.patch({ snapshots: { 'dev-1': { session: session([tmuxWindow('@1', [pane('%1')])]) } } });
    now += 10;
    fake.patch({
      snapshots: {
        'dev-1': {
          session: session([tmuxWindow('@1', [pane('%1')]), tmuxWindow('@2', [pane('%2')])]),
        },
      },
    });
    expect(timers.pendingCount).toBe(1);

    dispose();
    expect(timers.pendingCount).toBe(0);
    expect(readTmuxTopologyCache(PREFIX, storage, now)['dev-1']?.windows).toHaveLength(2);

    fake.patch({ snapshots: {} });
    expect(readTmuxTopologyCache(PREFIX, storage, now)['dev-1']).toBeDefined();
  });

  test('会话被清空（null session）时删掉缓存条目', () => {
    const timers = new FakeTimers();
    let now = 0;
    const fake = createFakeStore();
    const dispose = syncTmuxTopologyCache(fake.store, {
      storagePrefix: PREFIX,
      storage,
      now: () => now,
      timers,
    });

    fake.patch({ snapshots: { 'dev-1': { session: session([tmuxWindow('@1', [pane('%1')])]) } } });
    expect(readTmuxTopologyCache(PREFIX, storage, now)['dev-1']).toBeDefined();

    now += TOPOLOGY_WRITE_INTERVAL_MS;
    fake.patch({ snapshots: { 'dev-1': { session: null } } });
    expect(readTmuxTopologyCache(PREFIX, storage, now)['dev-1']).toBeUndefined();

    dispose();
  });

  test('metadata-patch 抖动（新对象、同拓扑）不产生任何写入', () => {
    const timers = new FakeTimers();
    const counting = countingStorage();
    let now = 0;
    const fake = createFakeStore();
    const dispose = syncTmuxTopologyCache(fake.store, {
      storagePrefix: PREFIX,
      storage: counting,
      now: () => now,
      timers,
    });

    // 每次都是全新的会话对象，但拓扑一模一样——正是网关按 pane 活动位打补丁时的形态
    for (let i = 0; i < 10; i += 1) {
      now += TOPOLOGY_WRITE_INTERVAL_MS;
      fake.patch({
        snapshots: { 'dev-1': { session: session([tmuxWindow('@1', [pane('%1')])]) } },
      });
      timers.runAll();
    }

    expect(counting.writes).toBe(1);

    // 真变化立刻落地
    now += TOPOLOGY_WRITE_INTERVAL_MS;
    fake.patch({
      snapshots: {
        'dev-1': { session: session([tmuxWindow('@1', [pane('%1', { title: 'nvim' })])]) },
      },
    });
    timers.runAll();
    expect(counting.writes).toBe(2);

    dispose();
  });

  test('dispose 后指纹作废：新 writer 遇到同一份拓扑仍会重新落盘', () => {
    const counting = countingStorage();
    let now = 0;
    const start = () => {
      const timers = new FakeTimers();
      const fake = createFakeStore();
      const dispose = syncTmuxTopologyCache(fake.store, {
        storagePrefix: PREFIX,
        storage: counting,
        now: () => now,
        timers,
      });
      fake.patch({
        snapshots: { 'dev-1': { session: session([tmuxWindow('@1', [pane('%1')])]) } },
      });
      timers.runAll();
      dispose();
    };

    start();
    expect(counting.writes).toBe(1);
    now += TOPOLOGY_WRITE_INTERVAL_MS;
    start();
    expect(counting.writes).toBe(2);
  });
});
