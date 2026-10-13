// 节点设备数的规则（磁贴跨度据此决定）：与面板画的卡片同一条——真实列表优先，否则快照，再否则 inventory。

import { describe, expect, test } from 'bun:test';
import {
  type DeviceSnapshotStorage,
  deviceSnapshotKey,
  offlineDevices,
} from './device-snapshot-store';
import {
  estimateNodeDeviceCount,
  nextSnapshotCounts,
  readSnapshotCount,
  resolveNodeDeviceCount,
} from './use-node-device-counts';

const NODE_ID = '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c';

function memoryStorage(initial: Record<string, string> = {}): DeviceSnapshotStorage & {
  reads: string[];
} {
  const entries = new Map(Object.entries(initial));
  const reads: string[] = [];
  return {
    reads,
    getItem: (key) => {
      reads.push(key);
      return entries.get(key) ?? null;
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

function snapshot(count: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      id: `d${index}`,
      name: `设备 ${index}`,
      type: 'local',
      sortOrder: index,
    }))
  );
}

/** 夹具节点：inventory 里有 `inventoryCount` 台设备（缺省没有 inventory） */
function node(inventoryCount?: number, runtimeNodeId = NODE_ID) {
  const inventory =
    inventoryCount === undefined
      ? null
      : { devices: Array.from({ length: inventoryCount }, (_, index) => ({ id: `i${index}` })) };
  return { runtimeNodeId, inventory };
}

describe('readSnapshotCount', () => {
  test('有快照返回它的长度（空快照是 0），没有快照 / 没有存储返回 null', () => {
    const withSnapshot = (count: number) =>
      memoryStorage({ [deviceSnapshotKey(NODE_ID)]: snapshot(count) });
    expect(readSnapshotCount(NODE_ID, withSnapshot(3))).toBe(3);
    expect(readSnapshotCount(NODE_ID, withSnapshot(0))).toBe(0);
    expect(readSnapshotCount(NODE_ID, memoryStorage())).toBeNull();
    expect(readSnapshotCount(NODE_ID, null)).toBeNull();
  });
});

describe('estimateNodeDeviceCount（与离线面板画的卡片数同一条规则）', () => {
  test('有快照就用快照，不与 inventory 相加、也不取大', () => {
    expect(estimateNodeDeviceCount(3, node(5).inventory)).toBe(3);
    // 评审里的场景：快照 1 台、inventory 3 台 → 面板只画 1 张卡，磁贴也只占一格
    expect(estimateNodeDeviceCount(1, node(3).inventory)).toBe(1);
    expect(estimateNodeDeviceCount(0, node(3).inventory)).toBe(0);
  });

  test('没有快照才用 inventory；都没有是 0', () => {
    expect(estimateNodeDeviceCount(null, node(2).inventory)).toBe(2);
    expect(estimateNodeDeviceCount(undefined, node(2).inventory)).toBe(2);
    expect(estimateNodeDeviceCount(null, null)).toBe(0);
  });

  test('与 offlineDevices 的结果逐一对得上', () => {
    const cases: [number | null, number | undefined][] = [
      [1, 3],
      [3, 1],
      [null, 2],
      [null, undefined],
      [0, 4],
    ];
    for (const [snapshotCount, inventoryCount] of cases) {
      const storage = memoryStorage(
        snapshotCount === null ? {} : { [deviceSnapshotKey(NODE_ID)]: snapshot(snapshotCount) }
      );
      const { inventory } = node(inventoryCount);
      expect(estimateNodeDeviceCount(readSnapshotCount(NODE_ID, storage), inventory)).toBe(
        offlineDevices(NODE_ID, inventory, storage).length
      );
    }
  });
});

describe('nextSnapshotCounts', () => {
  test('新节点读一次存储；见过的节点不再读，节点列表刷新（inventory 变了）也不改口', () => {
    const storage = memoryStorage({ [deviceSnapshotKey(NODE_ID)]: snapshot(1) });
    const first = nextSnapshotCounts(new Map(), [node()], storage);
    expect(first.get(NODE_ID)).toBe(1);
    const readsAfterFirst = storage.reads.length;
    expect(readsAfterFirst).toBeGreaterThan(0);

    const refreshed = nextSnapshotCounts(first, [node(3)], storage);
    expect(refreshed.get(NODE_ID)).toBe(1);
    expect(storage.reads.length).toBe(readsAfterFirst);
    // 整条链路：刷新之后磁贴仍按快照的 1 台算
    expect(estimateNodeDeviceCount(refreshed.get(NODE_ID), node(3).inventory)).toBe(1);
  });

  test('没有快照记成 null（不是 0），之后跟着 inventory 走', () => {
    const counts = nextSnapshotCounts(new Map(), [node()], memoryStorage());
    expect(counts.get(NODE_ID)).toBeNull();
    const kept = nextSnapshotCounts(counts, [node(2)], memoryStorage());
    expect(estimateNodeDeviceCount(kept.get(NODE_ID), node(2).inventory)).toBe(2);
    expect(estimateNodeDeviceCount(kept.get(NODE_ID), node(1).inventory)).toBe(1);
  });

  test('已经不在列表里的节点被丢掉', () => {
    const next = nextSnapshotCounts(
      new Map<string, number | null>([
        ['gone', 3],
        ['kept', 2],
      ]),
      [node(undefined, 'kept')],
      memoryStorage()
    );
    expect([...next.keys()]).toEqual(['kept']);
    expect(next.get('kept')).toBe(2);
  });
});

describe('resolveNodeDeviceCount', () => {
  test('真实列表优先，可以比估计值大也可以小', () => {
    expect(resolveNodeDeviceCount(1, 3)).toBe(1);
    expect(resolveNodeDeviceCount(4, 2)).toBe(4);
  });

  test('没有真实列表用估计值；空列表 / 估计为 0 按一台算（磁贴至少占一格）', () => {
    expect(resolveNodeDeviceCount(undefined, 3)).toBe(3);
    expect(resolveNodeDeviceCount(undefined, 0)).toBe(1);
    expect(resolveNodeDeviceCount(0, 3)).toBe(1);
  });
});
