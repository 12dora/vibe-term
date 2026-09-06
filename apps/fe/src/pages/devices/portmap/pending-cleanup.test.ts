// 待清理放行清单：解析容错、去重、上限与持久化。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  MAX_PENDING_CLEANUPS,
  PENDING_CLEANUP_KEY,
  type PendingCleanupStorage,
  type PendingExportCleanup,
  parsePendingCleanups,
  pendingExportCleanups,
  recordPendingExportCleanup,
  resetPendingExportCleanupsForTest,
  resolvePendingExportCleanup,
  setPendingCleanupStorageForTest,
  subscribePendingExportCleanups,
} from './pending-cleanup';

const ENTRY = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const REMOTE = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';

function memoryStorage(initial: Record<string, string> = {}): PendingCleanupStorage & {
  entries: Map<string, string>;
} {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

function record(mapId: string, overrides: Partial<PendingExportCleanup> = {}) {
  return {
    mapId,
    listenMeshId: ENTRY,
    targetMeshId: REMOTE,
    label: '8080',
    confirmed: true,
    createdAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  setPendingCleanupStorageForTest(memoryStorage());
  resetPendingExportCleanupsForTest();
});

afterEach(() => {
  setPendingCleanupStorageForTest(null);
});

describe('parsePendingCleanups', () => {
  test('坏数据一律丢掉，不卡住整张清单', () => {
    expect(parsePendingCleanups(null)).toEqual([]);
    expect(parsePendingCleanups('not json')).toEqual([]);
    expect(parsePendingCleanups('{"a":1}')).toEqual([]);
    expect(
      parsePendingCleanups(
        JSON.stringify([
          { mapId: '', listenMeshId: ENTRY, targetMeshId: REMOTE },
          { mapId: 'm1', listenMeshId: 1, targetMeshId: REMOTE },
          { mapId: 'm2', listenMeshId: ENTRY, targetMeshId: REMOTE },
        ])
      )
    ).toEqual([
      {
        mapId: 'm2',
        listenMeshId: ENTRY,
        targetMeshId: REMOTE,
        label: 'm2',
        confirmed: false,
        createdAt: 0,
      },
    ]);
  });
});

describe('清单', () => {
  test('登记后可读到，同一 mapId 只留最新一条', () => {
    recordPendingExportCleanup(record('m1', { label: 'a' }));
    recordPendingExportCleanup(record('m1', { label: 'b' }));
    expect(pendingExportCleanups()).toHaveLength(1);
    expect(pendingExportCleanups()[0].label).toBe('b');
  });

  test('清理成功后摘掉，摘不存在的不通知订阅者', () => {
    let notified = 0;
    const unsubscribe = subscribePendingExportCleanups(() => {
      notified += 1;
    });
    recordPendingExportCleanup(record('m1'));
    resolvePendingExportCleanup('m2');
    expect(notified).toBe(1);
    resolvePendingExportCleanup('m1');
    expect(notified).toBe(2);
    expect(pendingExportCleanups()).toHaveLength(0);
    unsubscribe();
  });

  test('超过上限只留最近的', () => {
    for (let i = 0; i < MAX_PENDING_CLEANUPS + 5; i += 1) {
      recordPendingExportCleanup(record(`m${i}`));
    }
    const list = pendingExportCleanups();
    expect(list).toHaveLength(MAX_PENDING_CLEANUPS);
    expect(list[list.length - 1].mapId).toBe(`m${MAX_PENDING_CLEANUPS + 4}`);
  });

  test('落盘后刷新（重新读 storage）仍能拿到', () => {
    const storage = memoryStorage();
    setPendingCleanupStorageForTest(storage);
    resetPendingExportCleanupsForTest();
    recordPendingExportCleanup(record('m1'));
    expect(storage.entries.has(PENDING_CLEANUP_KEY)).toBe(true);

    // 模拟刷新：缓存清空，重新从 storage 读
    setPendingCleanupStorageForTest(storage);
    expect(pendingExportCleanups().map((item) => item.mapId)).toEqual(['m1']);
  });

  test('storage 不可用时退化成仅本次会话有效', () => {
    setPendingCleanupStorageForTest(null);
    resetPendingExportCleanupsForTest();
    recordPendingExportCleanup(record('m1'));
    expect(pendingExportCleanups()).toHaveLength(1);
  });
});
