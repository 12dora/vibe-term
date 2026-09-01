// 批量升级计划的落盘：读写、TTL、脏数据、存储抛异常时的降级，以及标签页归属。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createMemoryStorage } from '@tmex/stores/test-utils';
import {
  UPGRADE_BATCH_OWNER_STALE_MS,
  UPGRADE_BATCH_TTL_MS,
  type UpgradeBatchPlan,
  batchOwnedByOtherTab,
  batchPlanKey,
  canAdoptBatchPlan,
  clearBatchPlan,
  createBatchPlan,
  createBatchPlanSink,
  currentTabId,
  isBatchPlanStorageEvent,
  loadBatchPlan,
  planRemaining,
  saveBatchPlan,
} from './upgrade-batch-storage';

const KEY = 'tmex.nodes.upgrade-batch.entry';
const TAB_KEY = 'tmex.nodes.upgrade-batch.tab';

const saved = new Map<string, PropertyDescriptor | undefined>();

function install(local: Storage | null, session: Storage | null): void {
  for (const [key, value] of [
    ['localStorage', local],
    ['sessionStorage', session],
  ] as const) {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
}

let store: Storage;

beforeEach(() => {
  store = createMemoryStorage();
  install(store, createMemoryStorage());
});

afterEach(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

function plan(overrides: Partial<UpgradeBatchPlan> = {}): UpgradeBatchPlan {
  return {
    ...createBatchPlan({
      entryNodeId: 'entry',
      targetVersion: '1.2.0',
      order: [['a', 'b'], ['hub'], ['entry']],
      now: 1000,
      tabId: 'tab-1',
    }),
    ...overrides,
  };
}

/** 每次读写都抛的存储：隐私模式 / 配额耗尽的模拟。 */
function throwingStorage(): Storage {
  const boom = () => {
    throw new Error('quota exceeded');
  };
  return {
    get length(): number {
      return boom();
    },
    clear: boom,
    getItem: boom,
    key: boom,
    removeItem: boom,
    setItem: boom,
  } as unknown as Storage;
}

describe('计划的读写', () => {
  test('存进去再读出来还是同一份', () => {
    const source = plan();
    saveBatchPlan(source);
    expect(loadBatchPlan('entry', 1000)).toEqual(source);
    expect(store.getItem(KEY)).toContain('"schema":1');
  });

  test('没有计划时返回 null', () => {
    expect(loadBatchPlan('entry', 1000)).toBeNull();
  });

  test('入口节点对不上：不认，并把这条清掉', () => {
    saveBatchPlan(plan({ entryNodeId: 'other' }));
    store.setItem(KEY, store.getItem('tmex.nodes.upgrade-batch.other') ?? '');
    expect(loadBatchPlan('entry', 1000)).toBeNull();
    expect(store.getItem(KEY)).toBeNull();
  });

  test('超过 TTL 的计划作废并清掉', () => {
    saveBatchPlan(plan({ updatedAt: 1000 }));
    expect(loadBatchPlan('entry', 1000 + UPGRADE_BATCH_TTL_MS)).not.toBeNull();
    saveBatchPlan(plan({ updatedAt: 1000 }));
    expect(loadBatchPlan('entry', 1001 + UPGRADE_BATCH_TTL_MS)).toBeNull();
    expect(store.getItem(KEY)).toBeNull();
  });

  test('汇总已经弹过的计划不再复活', () => {
    saveBatchPlan(plan({ summaryEmitted: true }));
    expect(loadBatchPlan('entry', 1000)).toBeNull();
    expect(store.getItem(KEY)).toBeNull();
  });

  test('脏数据（坏 JSON / 缺字段 / 结论不认识）一律丢掉', () => {
    for (const raw of [
      '{oops',
      '"not-an-object"',
      JSON.stringify({ ...plan(), schema: 2 }),
      JSON.stringify({ ...plan(), order: [['a'], 3] }),
      JSON.stringify({ ...plan(), updatedAt: '1000' }),
      JSON.stringify({ ...plan(), ownerTabId: null }),
      JSON.stringify({ ...plan(), done: [{ nodeId: 'a', outcome: 'exploded' }] }),
      JSON.stringify({ ...plan(), done: [{ outcome: 'done' }] }),
    ]) {
      store.setItem(KEY, raw);
      expect(loadBatchPlan('entry', 1000)).toBeNull();
      expect(store.getItem(KEY)).toBeNull();
    }
  });

  test('clearBatchPlan 只删自己那一条', () => {
    saveBatchPlan(plan());
    saveBatchPlan(plan({ entryNodeId: 'other' }));
    clearBatchPlan('entry');
    expect(store.getItem(KEY)).toBeNull();
    expect(store.getItem('tmex.nodes.upgrade-batch.other')).not.toBeNull();
  });
});

describe('存储不可用时的降级', () => {
  test('没有 localStorage：读写都不抛，只是读不回来', () => {
    install(null, createMemoryStorage());
    expect(() => saveBatchPlan(plan())).not.toThrow();
    expect(() => clearBatchPlan('entry')).not.toThrow();
    expect(loadBatchPlan('entry', 1000)).toBeNull();
  });

  test('localStorage 每次都抛：读写都不抛，续跑能力退化成没有', () => {
    install(throwingStorage(), createMemoryStorage());
    expect(() => saveBatchPlan(plan())).not.toThrow();
    expect(() => clearBatchPlan('entry')).not.toThrow();
    expect(loadBatchPlan('entry', 1000)).toBeNull();
    const sink = createBatchPlanSink(plan(), () => 2000);
    expect(() => {
      sink.settled('a', 'done');
      sink.touch();
      sink.finish();
    }).not.toThrow();
  });

  test('sessionStorage 抛异常时仍给得出一个稳定的标签页 id', () => {
    install(createMemoryStorage(), throwingStorage());
    const id = currentTabId();
    expect(id).toBeTruthy();
    expect(currentTabId()).toBe(id);
  });
});

describe('planRemaining', () => {
  test('去掉已收尾的节点，空组不占位，顺序不变', () => {
    const source = plan({
      done: [
        { nodeId: 'a', outcome: 'done' },
        { nodeId: 'b', outcome: 'failed' },
      ],
    });
    expect(planRemaining(source)).toEqual([['hub'], ['entry']]);
    expect(planRemaining(plan())).toEqual([['a', 'b'], ['hub'], ['entry']]);
  });
});

describe('标签页归属', () => {
  test('同一标签页刷新后 id 不变，认得自己发起的批量', () => {
    const first = currentTabId();
    expect(currentTabId()).toBe(first);
    expect(globalThis.sessionStorage.getItem(TAB_KEY)).toBe(first);
    expect(canAdoptBatchPlan(plan({ ownerTabId: first, updatedAt: 1000 }), first, 1000)).toBe(true);
  });

  test('别的标签页心跳还新鲜就不抢，停摆超过 30 秒才接管', () => {
    const other = plan({ ownerTabId: 'tab-9', updatedAt: 1000 });
    expect(canAdoptBatchPlan(other, 'tab-1', 1000 + UPGRADE_BATCH_OWNER_STALE_MS)).toBe(false);
    expect(canAdoptBatchPlan(other, 'tab-1', 1001 + UPGRADE_BATCH_OWNER_STALE_MS)).toBe(true);
  });

  test('别的标签页正跑着这批：不许另开一批；心跳停摆后放行', () => {
    saveBatchPlan(plan({ ownerTabId: 'tab-9', updatedAt: 1000 }));
    expect(batchOwnedByOtherTab('entry', 'tab-1', 1000)).toBe(true);
    // 自己那份永远认
    expect(batchOwnedByOtherTab('entry', 'tab-9', 1000)).toBe(false);
    expect(batchOwnedByOtherTab('entry', 'tab-1', 1001 + UPGRADE_BATCH_OWNER_STALE_MS)).toBe(false);
  });

  test('没有计划 / 入口未知时一律放行', () => {
    expect(batchOwnedByOtherTab('entry', 'tab-1', 1000)).toBe(false);
    saveBatchPlan(plan({ ownerTabId: 'tab-9', updatedAt: 1000 }));
    expect(batchOwnedByOtherTab(null, 'tab-1', 1000)).toBe(false);
  });

  test('storage 事件只认本入口的计划键；整片清空同样要重读', () => {
    expect(batchPlanKey('entry')).toBe(KEY);
    expect(isBatchPlanStorageEvent('entry', KEY)).toBe(true);
    expect(isBatchPlanStorageEvent('entry', null)).toBe(true);
    expect(isBatchPlanStorageEvent('entry', batchPlanKey('other'))).toBe(false);
    expect(isBatchPlanStorageEvent('entry', 'tmex.something.else')).toBe(false);
  });
});

describe('createBatchPlanSink', () => {
  test('建起来就落盘；每台机器落定后写一次，同一台不重复记', () => {
    let now = 5000;
    const sink = createBatchPlanSink(plan(), () => now);
    expect(loadBatchPlan('entry', now)?.updatedAt).toBe(5000);

    now = 6000;
    sink.settled('a', 'done');
    sink.settled('a', 'failed');
    const stored = loadBatchPlan('entry', now);
    expect(stored?.done).toEqual([{ nodeId: 'a', outcome: 'done' }]);
    expect(stored?.updatedAt).toBe(6000);
  });

  test('心跳只刷新 updatedAt', () => {
    let now = 5000;
    const sink = createBatchPlanSink(plan(), () => now);
    sink.settled('a', 'done');
    now = 9000;
    sink.touch();
    expect(loadBatchPlan('entry', now)?.updatedAt).toBe(9000);
    expect(loadBatchPlan('entry', now)?.done).toHaveLength(1);
  });

  test('收尾：先记 summaryEmitted 再删，删不掉也不会被再次续跑', () => {
    const sink = createBatchPlanSink(plan(), () => 5000);
    sink.finish();
    expect(store.getItem(KEY)).toBeNull();
    expect(sink.plan().summaryEmitted).toBe(true);
    // 删除失败的极端情况：留下的那份也已经带上 summaryEmitted，加载时会被判作废
    store.setItem(KEY, JSON.stringify(sink.plan()));
    expect(loadBatchPlan('entry', 5000)).toBeNull();
  });
});
