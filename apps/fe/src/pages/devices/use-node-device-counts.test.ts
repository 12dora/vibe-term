// 节点设备数的来源与合并规则（磁贴跨度据此决定）：快照 / inventory 给估计值，真实列表给权威值。

import { describe, expect, test } from 'bun:test';
import { type DeviceSnapshotStorage, deviceSnapshotKey } from './device-snapshot-store';
import {
  nextNodeDeviceSeeds,
  resolveNodeDeviceCount,
  seedNodeDeviceCount,
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

describe('seedNodeDeviceCount', () => {
  test('有离线快照用快照的长度（不与 inventory 相加）', () => {
    const storage = memoryStorage({ [deviceSnapshotKey(NODE_ID)]: snapshot(3) });
    expect(seedNodeDeviceCount(node(5), storage)).toBe(3);
  });

  test('没有快照退回 inventory；都没有按一台算', () => {
    const storage = memoryStorage();
    expect(seedNodeDeviceCount(node(2), storage)).toBe(2);
    expect(seedNodeDeviceCount(node(), storage)).toBe(1);
    expect(seedNodeDeviceCount(node(), null)).toBe(1);
  });

  test('快照是空列表也按一台算（磁贴至少占一格）', () => {
    const storage = memoryStorage({ [deviceSnapshotKey(NODE_ID)]: snapshot(0) });
    expect(seedNodeDeviceCount(node(), storage)).toBe(1);
  });
});

describe('nextNodeDeviceSeeds', () => {
  test('新节点读快照；见过的节点不再读存储，只跟 inventory 比大', () => {
    const storage = memoryStorage({ [deviceSnapshotKey(NODE_ID)]: snapshot(2) });
    const first = nextNodeDeviceSeeds(new Map(), [node()], storage);
    expect(first.get(NODE_ID)).toBe(2);
    const readsAfterFirst = storage.reads.length;
    expect(readsAfterFirst).toBeGreaterThan(0);

    // inventory 后到且更多：放宽
    const wider = nextNodeDeviceSeeds(first, [node(3)], storage);
    expect(wider.get(NODE_ID)).toBe(3);
    // inventory 变少：估计值只增不减
    const kept = nextNodeDeviceSeeds(wider, [node(1)], storage);
    expect(kept.get(NODE_ID)).toBe(3);
    expect(storage.reads.length).toBe(readsAfterFirst);
  });

  test('已经不在列表里的节点被丢掉', () => {
    const next = nextNodeDeviceSeeds(
      new Map([
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
  test('权威值优先，可以比估计值小', () => {
    expect(resolveNodeDeviceCount(1, 3)).toBe(1);
    expect(resolveNodeDeviceCount(4, 2)).toBe(4);
  });

  test('没有权威值用估计值；都没有 / 空列表按一台算', () => {
    expect(resolveNodeDeviceCount(undefined, 3)).toBe(3);
    expect(resolveNodeDeviceCount(undefined, undefined)).toBe(1);
    expect(resolveNodeDeviceCount(0, 3)).toBe(1);
  });
});
