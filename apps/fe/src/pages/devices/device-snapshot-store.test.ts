// 节点设备列表的离线快照：落盘字段、读取校验、inventory 兜底。

import { describe, expect, test } from 'bun:test';
import type { Device } from '@tmex/shared';
import {
  type DeviceSnapshotStorage,
  MAX_SNAPSHOTS,
  clearDeviceSnapshot,
  deviceSnapshotKey,
  inventoryFallbackDevices,
  listDeviceSnapshotNodeIds,
  offlineDevices,
  pruneDeviceSnapshots,
  readDeviceSnapshot,
  toSnapshotDevice,
  writeDeviceSnapshot,
} from './device-snapshot-store';

const NODE_ID = '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c';

function memoryStorage(initial: Record<string, string> = {}): DeviceSnapshotStorage & {
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

const DEVICE: Device = {
  id: 'd1',
  name: '书房',
  type: 'ssh',
  host: '10.0.0.2',
  port: 22,
  username: 'root',
  authMode: 'password',
  passwordEnc: 'secret',
  privateKeyEnc: 'secret-key',
  sortOrder: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('device-snapshot-store', () => {
  test('快照按节点分键，写入后原样读回，凭证字段不落盘', () => {
    const storage = memoryStorage();
    writeDeviceSnapshot(NODE_ID, [DEVICE], storage);
    const raw = storage.entries.get(deviceSnapshotKey(NODE_ID)) ?? '';
    expect(raw).not.toContain('secret');
    expect(readDeviceSnapshot(NODE_ID, storage)).toEqual([toSnapshotDevice(DEVICE)]);
    expect(readDeviceSnapshot('other', storage)).toBeNull();
  });

  test('坏数据 / 非数组 / 缺字段的条目被过滤', () => {
    const storage = memoryStorage({
      [deviceSnapshotKey(NODE_ID)]: JSON.stringify([
        { id: 'ok', name: 'ok', type: 'local', sortOrder: 0 },
        { id: 'bad-type', name: 'x', type: 'usb', sortOrder: 0 },
        { name: 'no-id', type: 'local', sortOrder: 0 },
        null,
      ]),
      [deviceSnapshotKey('broken')]: '{not json',
      [deviceSnapshotKey('object')]: '{"id":"x"}',
    });
    expect(readDeviceSnapshot(NODE_ID, storage)?.map((device) => device.id)).toEqual(['ok']);
    expect(readDeviceSnapshot('broken', storage)).toBeNull();
    expect(readDeviceSnapshot('object', storage)).toBeNull();
  });

  test('clearDeviceSnapshot 只删自己的键', () => {
    const storage = memoryStorage();
    writeDeviceSnapshot(NODE_ID, [DEVICE], storage);
    writeDeviceSnapshot('other', [DEVICE], storage);
    clearDeviceSnapshot(NODE_ID, storage);
    expect(readDeviceSnapshot(NODE_ID, storage)).toBeNull();
    expect(readDeviceSnapshot('other', storage)).not.toBeNull();
  });

  test('没有 storage 时读写都静默', () => {
    writeDeviceSnapshot(NODE_ID, [DEVICE], null);
    expect(readDeviceSnapshot(NODE_ID, null)).toBeNull();
  });

  test('inventory 里的简化设备映射成最小 DTO，保持顺序', () => {
    const devices = inventoryFallbackDevices({
      devices: [
        { id: 'a', name: '客厅' },
        { id: 'b' },
        { id: 'c', name: '远端', type: 'ssh' },
        { name: 'no-id' },
        'junk',
      ],
    });
    expect(
      devices.map((device) => [device.id, device.name, device.type, device.sortOrder])
    ).toEqual([
      ['a', '客厅', 'local', 0],
      ['b', 'b', 'local', 1],
      ['c', '远端', 'ssh', 2],
    ]);
    expect(inventoryFallbackDevices(null)).toEqual([]);
    expect(inventoryFallbackDevices({ devices: 3 })).toEqual([]);
  });

  test('pruneDeviceSnapshots 只保留仍在列表里的节点', () => {
    const storage = memoryStorage();
    writeDeviceSnapshot('self', [DEVICE], storage, 1);
    writeDeviceSnapshot(NODE_ID, [DEVICE], storage, 2);
    writeDeviceSnapshot('gone', [DEVICE], storage, 3);
    pruneDeviceSnapshots(['self', NODE_ID], storage);
    expect(listDeviceSnapshotNodeIds(storage).sort()).toEqual([NODE_ID, 'self'].sort());
    expect(readDeviceSnapshot('gone', storage)).toBeNull();
    expect(readDeviceSnapshot(NODE_ID, storage)).not.toBeNull();
  });

  test('条目封顶：超过上限时按 updatedAt 淘汰最旧的', () => {
    const storage = memoryStorage();
    for (let i = 0; i < MAX_SNAPSHOTS; i += 1) {
      writeDeviceSnapshot(`node-${i}`, [DEVICE], storage, 1000 + i);
    }
    // 回头再写最旧的一条，让它变成最新
    writeDeviceSnapshot('node-0', [DEVICE], storage, 5000);
    writeDeviceSnapshot('node-new', [DEVICE], storage, 6000);
    const ids = listDeviceSnapshotNodeIds(storage);
    expect(ids).toHaveLength(MAX_SNAPSHOTS);
    expect(ids).toContain('node-new');
    expect(ids).toContain('node-0');
    expect(ids).not.toContain('node-1');
    expect(readDeviceSnapshot('node-1', storage)).toBeNull();
  });

  test('撞配额：淘汰最旧的一条后重试一次', () => {
    const inner = memoryStorage();
    let failures = 1;
    const storage: DeviceSnapshotStorage = {
      getItem: inner.getItem,
      removeItem: inner.removeItem,
      setItem: (key, value) => {
        if (key === deviceSnapshotKey('new') && failures > 0) {
          failures -= 1;
          throw new DOMException('quota', 'QuotaExceededError');
        }
        inner.setItem(key, value);
      },
    };
    writeDeviceSnapshot('old', [DEVICE], storage, 1);
    writeDeviceSnapshot('newer', [DEVICE], storage, 2);
    writeDeviceSnapshot('new', [DEVICE], storage, 3);
    expect(readDeviceSnapshot('new', storage)).not.toBeNull();
    expect(readDeviceSnapshot('old', storage)).toBeNull();
    expect(readDeviceSnapshot('newer', storage)).not.toBeNull();
    expect(listDeviceSnapshotNodeIds(storage).sort()).toEqual(['new', 'newer']);
  });

  test('重试仍失败：不写索引，已有条目不动', () => {
    const inner = memoryStorage();
    const storage: DeviceSnapshotStorage = {
      getItem: inner.getItem,
      removeItem: inner.removeItem,
      setItem: (key, value) => {
        if (key === deviceSnapshotKey('new')) throw new Error('quota');
        inner.setItem(key, value);
      },
    };
    writeDeviceSnapshot('a', [DEVICE], storage, 1);
    writeDeviceSnapshot('b', [DEVICE], storage, 2);
    writeDeviceSnapshot('new', [DEVICE], storage, 3);
    expect(readDeviceSnapshot('new', storage)).toBeNull();
    expect(listDeviceSnapshotNodeIds(storage)).toEqual(['b']);
  });

  test('offlineDevices：没有快照时退回 inventory', () => {
    const storage = memoryStorage();
    const inventory = { devices: [{ id: 'inv', name: 'inventory' }] };
    expect(offlineDevices('never-seen', inventory, storage).map((device) => device.id)).toEqual([
      'inv',
    ]);
  });

  test('读快照按 id 去重：库里存进过重复条目也只出一张卡片', () => {
    const storage = memoryStorage({
      [deviceSnapshotKey(NODE_ID)]: JSON.stringify([
        toSnapshotDevice(DEVICE),
        { ...toSnapshotDevice(DEVICE), name: '书房（重复）' },
        { ...toSnapshotDevice(DEVICE), id: 'd2', name: '客厅' },
      ]),
    });
    const devices = readDeviceSnapshot(NODE_ID, storage) ?? [];
    expect(devices.map((device) => device.id)).toEqual(['d1', 'd2']);
    expect(devices[0]?.name).toBe('书房');
  });

  test('inventory 兜底按 id 去重，且不认没有 id 的条目', () => {
    const devices = inventoryFallbackDevices({
      devices: [
        { id: 'a', name: 'A' },
        { id: 'a', name: 'A 重复' },
        { name: '没有 id' },
        { id: 'b' },
      ],
    });
    expect(devices.map((device) => device.id)).toEqual(['a', 'b']);
    expect(devices[0]?.name).toBe('A');
  });

  test('快照与 inventory 不合并：有快照就完全以快照为准', () => {
    const storage = memoryStorage();
    writeDeviceSnapshot(NODE_ID, [DEVICE], storage);
    // inventory 里是另一台设备：合并的话会出现两条，只认快照才只剩 d1
    const inventory = { devices: [{ id: 'only-in-inventory', name: '只在 inventory 里' }] };
    expect(offlineDevices(NODE_ID, inventory, storage).map((device) => device.id)).toEqual(['d1']);
  });
});
