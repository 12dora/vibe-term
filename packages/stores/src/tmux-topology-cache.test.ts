import { beforeEach, describe, expect, test } from 'bun:test';
import type { TmuxPane, TmuxSession, TmuxWindow } from '@vibeterm/shared';
import { createMemoryStorage } from './test-utils';
import {
  type CachedTopology,
  MAX_CACHED_DEVICES,
  MAX_CACHED_PANES,
  MAX_CACHED_WINDOWS,
  TMUX_TOPOLOGY_CACHE_VERSION,
  TMUX_TOPOLOGY_TTL_MS,
  TOPOLOGY_WRITE_INTERVAL_MS,
  type TmuxTopologyPlaceholders,
  type TopologySyncState,
  type TopologySyncStore,
  type TopologySyncTimers,
  clearTmuxTopologyCache,
  pruneTmuxTopologyCache,
  readTmuxTopologyCache,
  removeTmuxTopology,
  syncTmuxTopologyCache,
  tmuxTopologyCacheKey,
  toCachedTopology,
  writeTmuxTopology,
} from './tmux-topology-cache';

const PREFIX = 'n:test:';

function pane(id: string, overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    id,
    windowId: '@1',
    index: 0,
    active: true,
    width: 80,
    height: 24,
    ...overrides,
  };
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

describe('toCachedTopology', () => {
  test('只保留结构字段，不落尺寸与布局', () => {
    const topology = toCachedTopology(
      session([
        tmuxWindow(
          '@1',
          [pane('%1', { title: 'vim', currentCommand: 'vim', currentPath: '/secret' })],
          { layout: 'abcd,80x24,0,0,1', customName: '编辑' }
        ),
      ]),
      1000
    );

    expect(topology).toEqual({
      savedAt: 1000,
      windows: [
        {
          id: '@1',
          index: 0,
          name: 'zsh',
          active: true,
          customName: '编辑',
          panes: [{ id: '%1', index: 0, active: true, title: 'vim', currentCommand: 'vim' }],
        },
      ],
    });
    expect(JSON.stringify(topology)).not.toContain('/secret');
    expect(JSON.stringify(topology)).not.toContain('layout');
  });

  test('无会话 / 无窗口返回 null', () => {
    expect(toCachedTopology(null)).toBeNull();
    expect(toCachedTopology(session([]))).toBeNull();
  });

  test('窗口与 pane 数量封顶', () => {
    const panes = Array.from({ length: MAX_CACHED_PANES + 5 }, (_, i) => pane(`%${i}`));
    const windows = Array.from({ length: MAX_CACHED_WINDOWS + 5 }, (_, i) =>
      tmuxWindow(`@${i}`, panes)
    );
    const topology = toCachedTopology(session(windows));
    expect(topology?.windows).toHaveLength(MAX_CACHED_WINDOWS);
    expect(topology?.windows[0]?.panes).toHaveLength(MAX_CACHED_PANES);
  });
});

describe('拓扑缓存读写', () => {
  test('写入后可原样读回', () => {
    const topology = toCachedTopology(session([tmuxWindow('@1', [pane('%1')])]), 5_000);
    writeTmuxTopology(PREFIX, 'dev-1', topology as CachedTopology, storage, 5_000);

    expect(readTmuxTopologyCache(PREFIX, storage, 5_000)['dev-1']).toEqual(
      topology as CachedTopology
    );
  });

  test('键带 storagePrefix，不同 runtime 互不干扰', () => {
    const topology = toCachedTopology(
      session([tmuxWindow('@1', [pane('%1')])]),
      1
    ) as CachedTopology;
    writeTmuxTopology(PREFIX, 'dev-1', topology, storage, 1);
    writeTmuxTopology('', 'dev-2', topology, storage, 1);

    expect(storage.getItem(tmuxTopologyCacheKey(PREFIX))).not.toBeNull();
    expect(Object.keys(readTmuxTopologyCache(PREFIX, storage, 1))).toEqual(['dev-1']);
    expect(Object.keys(readTmuxTopologyCache('', storage, 1))).toEqual(['dev-2']);
  });

  test('超过 TTL 的条目读不出来', () => {
    const topology = toCachedTopology(
      session([tmuxWindow('@1', [pane('%1')])]),
      0
    ) as CachedTopology;
    writeTmuxTopology(PREFIX, 'dev-1', topology, storage, 0);

    expect(readTmuxTopologyCache(PREFIX, storage, TMUX_TOPOLOGY_TTL_MS)['dev-1']).toBeDefined();
    expect(
      readTmuxTopologyCache(PREFIX, storage, TMUX_TOPOLOGY_TTL_MS + 1)['dev-1']
    ).toBeUndefined();
  });

  test('版本号不符时整份作废', () => {
    const topology = toCachedTopology(
      session([tmuxWindow('@1', [pane('%1')])]),
      1
    ) as CachedTopology;
    writeTmuxTopology(PREFIX, 'dev-1', topology, storage, 1);
    const raw = JSON.parse(storage.getItem(tmuxTopologyCacheKey(PREFIX)) as string);
    expect(raw.version).toBe(TMUX_TOPOLOGY_CACHE_VERSION);
    storage.setItem(
      tmuxTopologyCacheKey(PREFIX),
      JSON.stringify({ ...raw, version: TMUX_TOPOLOGY_CACHE_VERSION + 1 })
    );

    expect(readTmuxTopologyCache(PREFIX, storage, 1)).toEqual({});
  });

  test('脏 JSON / 脏结构降级成空表，不抛错', () => {
    storage.setItem(tmuxTopologyCacheKey(PREFIX), '{not json');
    expect(readTmuxTopologyCache(PREFIX, storage, 1)).toEqual({});

    storage.setItem(
      tmuxTopologyCacheKey(PREFIX),
      JSON.stringify({
        version: TMUX_TOPOLOGY_CACHE_VERSION,
        devices: {
          'dev-bad': { savedAt: 'x', windows: [] },
          'dev-partial': {
            savedAt: 1,
            windows: [{ id: '@1', panes: [{ noId: true }, { id: '%9' }] }, 42],
          },
        },
      })
    );
    const parsed = readTmuxTopologyCache(PREFIX, storage, 1);
    expect(parsed['dev-bad']).toBeUndefined();
    expect(parsed['dev-partial']?.windows).toHaveLength(1);
    expect(parsed['dev-partial']?.windows[0]).toEqual({
      id: '@1',
      index: 0,
      name: '',
      active: false,
      panes: [{ id: '%9', index: 0, active: false }],
    });
  });

  test('设备条目数封顶，淘汰 savedAt 最旧的', () => {
    for (let i = 0; i < MAX_CACHED_DEVICES + 3; i += 1) {
      const topology = toCachedTopology(
        session([tmuxWindow('@1', [pane('%1')])]),
        1_000 + i
      ) as CachedTopology;
      writeTmuxTopology(PREFIX, `dev-${i}`, topology, storage, 1_000 + i);
    }
    const parsed = readTmuxTopologyCache(PREFIX, storage, 2_000);
    expect(Object.keys(parsed)).toHaveLength(MAX_CACHED_DEVICES);
    expect(parsed['dev-0']).toBeUndefined();
    expect(parsed[`dev-${MAX_CACHED_DEVICES + 2}`]).toBeDefined();
  });

  test('删除单台设备与整份清空', () => {
    const topology = toCachedTopology(
      session([tmuxWindow('@1', [pane('%1')])]),
      1
    ) as CachedTopology;
    writeTmuxTopology(PREFIX, 'dev-1', topology, storage, 1);
    writeTmuxTopology(PREFIX, 'dev-2', topology, storage, 1);

    removeTmuxTopology(PREFIX, 'dev-1', storage, 1);
    expect(Object.keys(readTmuxTopologyCache(PREFIX, storage, 1))).toEqual(['dev-2']);

    clearTmuxTopologyCache(PREFIX, storage);
    expect(storage.getItem(tmuxTopologyCacheKey(PREFIX))).toBeNull();
  });

  test('prune 只留下仍在设备列表里的条目', () => {
    const topology = toCachedTopology(
      session([tmuxWindow('@1', [pane('%1')])]),
      1
    ) as CachedTopology;
    writeTmuxTopology(PREFIX, 'dev-1', topology, storage, 1);
    writeTmuxTopology(PREFIX, 'dev-2', topology, storage, 1);
    writeTmuxTopology(PREFIX, 'dev-3', topology, storage, 1);

    pruneTmuxTopologyCache(PREFIX, ['dev-2'], storage, 1);

    expect(Object.keys(readTmuxTopologyCache(PREFIX, storage, 1))).toEqual(['dev-2']);
  });

  test('存储不可用时读写都静默降级', () => {
    const broken = {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('denied');
      },
      removeItem() {
        throw new Error('denied');
      },
    };
    const topology = toCachedTopology(
      session([tmuxWindow('@1', [pane('%1')])]),
      1
    ) as CachedTopology;
    expect(readTmuxTopologyCache(PREFIX, broken, 1)).toEqual({});
    expect(() => writeTmuxTopology(PREFIX, 'dev-1', topology, broken, 1)).not.toThrow();
    expect(() => clearTmuxTopologyCache(PREFIX, broken)).not.toThrow();
    expect(() => pruneTmuxTopologyCache(PREFIX, ['dev-1'], broken, 1)).not.toThrow();
    expect(readTmuxTopologyCache(PREFIX, null, 1)).toEqual({});
  });
});

// ---------- 写通 / 占位对账 ----------

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
});
