import { beforeEach, describe, expect, test } from 'bun:test';
import type { TmuxPane, TmuxSession, TmuxWindow } from '@vibeterm/shared';
import { createMemoryStorage } from './test-utils';
import {
  type CachedTopology,
  MAX_CACHED_DEVICES,
  MAX_CACHED_PANES,
  MAX_CACHED_TEXT_CHARS,
  MAX_CACHED_WINDOWS,
  MAX_CACHE_CHARS,
  TMUX_TOPOLOGY_CACHE_VERSION,
  TMUX_TOPOLOGY_TTL_MS,
  clearTmuxTopologyCache,
  pruneTmuxTopologyCache,
  readTmuxTopologyCache,
  removeTmuxTopology,
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

/** 记账用 Storage：句柄按存储实例缓存，每个用例换一份即天然隔离 */
function countingStorage() {
  const inner = createMemoryStorage();
  let writes = 0;
  let removes = 0;
  return {
    getItem: (key: string) => inner.getItem(key),
    setItem: (key: string, value: string) => {
      writes += 1;
      inner.setItem(key, value);
    },
    removeItem: (key: string) => {
      removes += 1;
      inner.removeItem(key);
    },
    get writes() {
      return writes;
    },
    get removes() {
      return removes;
    },
  };
}

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
    writeTmuxTopology(PREFIX, 'dev-1', topology as CachedTopology, storage);

    expect(readTmuxTopologyCache(PREFIX, storage, 5_000)['dev-1']).toEqual(
      topology as CachedTopology
    );
  });

  test('键带 storagePrefix，不同 runtime 互不干扰', () => {
    const topology = toCachedTopology(
      session([tmuxWindow('@1', [pane('%1')])]),
      1
    ) as CachedTopology;
    writeTmuxTopology(PREFIX, 'dev-1', topology, storage);
    writeTmuxTopology('', 'dev-2', topology, storage);

    expect(storage.getItem(tmuxTopologyCacheKey(PREFIX))).not.toBeNull();
    expect(Object.keys(readTmuxTopologyCache(PREFIX, storage, 1))).toEqual(['dev-1']);
    expect(Object.keys(readTmuxTopologyCache('', storage, 1))).toEqual(['dev-2']);
  });

  test('超过 TTL 的条目读不出来', () => {
    const topology = toCachedTopology(
      session([tmuxWindow('@1', [pane('%1')])]),
      0
    ) as CachedTopology;
    writeTmuxTopology(PREFIX, 'dev-1', topology, storage);

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
    writeTmuxTopology(PREFIX, 'dev-1', topology, storage);
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
      writeTmuxTopology(PREFIX, `dev-${i}`, topology, storage);
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
    writeTmuxTopology(PREFIX, 'dev-1', topology, storage);
    writeTmuxTopology(PREFIX, 'dev-2', topology, storage);

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
    writeTmuxTopology(PREFIX, 'dev-1', topology, storage);
    writeTmuxTopology(PREFIX, 'dev-2', topology, storage);
    writeTmuxTopology(PREFIX, 'dev-3', topology, storage);

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
    expect(() => writeTmuxTopology(PREFIX, 'dev-1', topology, broken)).not.toThrow();
    expect(() => clearTmuxTopologyCache(PREFIX, broken)).not.toThrow();
    expect(() => pruneTmuxTopologyCache(PREFIX, ['dev-1'], broken, 1)).not.toThrow();
    expect(readTmuxTopologyCache(PREFIX, null, 1)).toEqual({});
  });
});

describe('文本截断与体积预算', () => {
  const long = 'x'.repeat(MAX_CACHED_TEXT_CHARS + 80);

  test('落盘时截断窗口名 / pane 标题 / 自定义名 / 进程名', () => {
    const topology = toCachedTopology(
      session([
        tmuxWindow('@1', [pane('%1', { title: long, customName: long, currentCommand: long })], {
          name: long,
          customName: long,
        }),
      ]),
      1
    ) as CachedTopology;

    const win = topology.windows[0] as NonNullable<(typeof topology.windows)[number]>;
    expect(win.name).toHaveLength(MAX_CACHED_TEXT_CHARS);
    expect(win.customName).toHaveLength(MAX_CACHED_TEXT_CHARS);
    const cachedPane = win.panes[0] as NonNullable<(typeof win.panes)[number]>;
    expect(cachedPane.title).toHaveLength(MAX_CACHED_TEXT_CHARS);
    expect(cachedPane.customName).toHaveLength(MAX_CACHED_TEXT_CHARS);
    expect(cachedPane.currentCommand).toHaveLength(MAX_CACHED_TEXT_CHARS);
  });

  test('读侧同样截断：旧版本写下的长文本读回来也是截断的', () => {
    storage.setItem(
      tmuxTopologyCacheKey(PREFIX),
      JSON.stringify({
        version: TMUX_TOPOLOGY_CACHE_VERSION,
        devices: {
          'dev-1': {
            savedAt: 1,
            windows: [
              {
                id: '@1',
                index: 0,
                name: long,
                active: true,
                customName: long,
                panes: [{ id: '%1', index: 0, active: true, title: long, currentCommand: long }],
              },
            ],
          },
        },
      })
    );

    const win = readTmuxTopologyCache(PREFIX, storage, 1)['dev-1']?.windows[0];
    expect(win?.name).toHaveLength(MAX_CACHED_TEXT_CHARS);
    expect(win?.customName).toHaveLength(MAX_CACHED_TEXT_CHARS);
    expect(win?.panes[0]?.title).toHaveLength(MAX_CACHED_TEXT_CHARS);
    expect(win?.panes[0]?.currentCommand).toHaveLength(MAX_CACHED_TEXT_CHARS);
  });

  test('超出体积预算时淘汰最旧的，落盘的键永远不超预算', () => {
    // 每台设备塞满窗口 / pane，几台就能顶到 128 KiB
    const fatWindows = Array.from({ length: MAX_CACHED_WINDOWS }, (_, w) =>
      tmuxWindow(
        `@${w}`,
        Array.from({ length: MAX_CACHED_PANES }, (_, i) =>
          pane(`%${w}-${i}`, { title: 'y'.repeat(MAX_CACHED_TEXT_CHARS) })
        ),
        { name: 'z'.repeat(MAX_CACHED_TEXT_CHARS) }
      )
    );
    for (let i = 0; i < 12; i += 1) {
      const topology = toCachedTopology(session(fatWindows), 1_000 + i) as CachedTopology;
      writeTmuxTopology(PREFIX, `dev-${i}`, topology, storage);
    }

    const raw = storage.getItem(tmuxTopologyCacheKey(PREFIX)) as string;
    expect(raw.length).toBeLessThanOrEqual(MAX_CACHE_CHARS);
    const kept = Object.keys(readTmuxTopologyCache(PREFIX, storage, 1_100));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(12);
    // 保留的是最近写入的那几台
    expect(kept).toContain('dev-11');
    expect(kept).not.toContain('dev-0');
  });
});

describe('写入指纹去重', () => {
  function topologyAt(savedAt: number, title = 'vim'): CachedTopology {
    return toCachedTopology(
      session([tmuxWindow('@1', [pane('%1', { title })])]),
      savedAt
    ) as CachedTopology;
  }

  test('内容不变时只有 savedAt 在漂：一个字节都不写', () => {
    const counting = countingStorage();
    writeTmuxTopology(PREFIX, 'dev-1', topologyAt(1), counting);
    expect(counting.writes).toBe(1);

    for (let i = 0; i < 20; i += 1) {
      writeTmuxTopology(PREFIX, 'dev-1', topologyAt(2 + i), counting);
    }
    expect(counting.writes).toBe(1);
    expect(readTmuxTopologyCache(PREFIX, counting, 100)['dev-1']?.savedAt).toBe(1);
  });

  test('拓扑真变了才写', () => {
    const counting = countingStorage();
    writeTmuxTopology(PREFIX, 'dev-1', topologyAt(1), counting);
    writeTmuxTopology(PREFIX, 'dev-1', topologyAt(2, 'nvim'), counting);

    expect(counting.writes).toBe(2);
    expect(readTmuxTopologyCache(PREFIX, counting, 3)['dev-1']?.windows[0]?.panes[0]?.title).toBe(
      'nvim'
    );
  });

  test('删掉条目后指纹一并作废：同样的拓扑要重新落盘', () => {
    const counting = countingStorage();
    writeTmuxTopology(PREFIX, 'dev-1', topologyAt(1), counting);
    removeTmuxTopology(PREFIX, 'dev-1', counting, 2);
    const writesAfterRemove = counting.writes;

    writeTmuxTopology(PREFIX, 'dev-1', topologyAt(3), counting);
    expect(counting.writes).toBe(writesAfterRemove + 1);
    expect(readTmuxTopologyCache(PREFIX, counting, 4)['dev-1']).toBeDefined();
  });

  test('别的写入方（另一个标签页 / 登出清理）动过键时重新解析，不用陈旧内存副本覆盖', () => {
    const counting = countingStorage();
    writeTmuxTopology(PREFIX, 'dev-1', topologyAt(1), counting);
    clearTmuxTopologyCache(PREFIX, counting);

    expect(readTmuxTopologyCache(PREFIX, counting, 2)).toEqual({});
    writeTmuxTopology(PREFIX, 'dev-1', topologyAt(3), counting);
    expect(readTmuxTopologyCache(PREFIX, counting, 4)['dev-1']).toBeDefined();
  });

  test('内存副本同样受 TTL 约束：过期即清掉，下一次保存重新落盘', () => {
    const counting = countingStorage();
    writeTmuxTopology(PREFIX, 'dev-1', topologyAt(0), counting);

    expect(readTmuxTopologyCache(PREFIX, counting, TMUX_TOPOLOGY_TTL_MS + 1)).toEqual({});
    writeTmuxTopology(PREFIX, 'dev-1', topologyAt(TMUX_TOPOLOGY_TTL_MS + 2), counting);
    expect(
      readTmuxTopologyCache(PREFIX, counting, TMUX_TOPOLOGY_TTL_MS + 3)['dev-1']
    ).toBeDefined();
  });
});
