import { describe, expect, test } from 'bun:test';
import {
  CONNECTED_STORAGE_KEY,
  DISCONNECTED_STORAGE_KEY,
  type DeviceIdStorage,
  pruneUnknownDeviceIds,
  readPersistedIds,
  withDeviceId,
  withoutDeviceId,
  writePersistedIds,
} from './device-connection-persistence';

function createMemoryStorage(initial: Record<string, string> = {}): DeviceIdStorage & {
  entries: Map<string, string>;
} {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

describe('存储键', () => {
  test('键名以 tmex: 命名空间结尾，读写共用同一常量', () => {
    expect(CONNECTED_STORAGE_KEY.endsWith('tmex:connectedDevices')).toBe(true);
    expect(DISCONNECTED_STORAGE_KEY.endsWith('tmex:disconnectedDevices')).toBe(true);
    expect(CONNECTED_STORAGE_KEY).not.toBe(DISCONNECTED_STORAGE_KEY);
  });
});

describe('readPersistedIds 处理损坏载荷', () => {
  const corrupt: Array<[string, string]> = [
    ['截断的 JSON', '{oops'],
    ['对象而非数组', '{"a":1}'],
    ['空字符串', ''],
    ['字符串字面量', '"device-a"'],
    ['数字字面量', '42'],
    ['null 字面量', 'null'],
    ['嵌套数组', '[["device-a"]]'],
  ];

  for (const [name, raw] of corrupt) {
    test(`${name} 回退为空集合`, () => {
      const storage = createMemoryStorage({ key: raw });
      expect(readPersistedIds('key', storage).size).toBe(0);
    });
  }

  test('数组中混杂的非字符串与空字符串被过滤，其余保留', () => {
    const storage = createMemoryStorage({
      key: JSON.stringify(['device-a', 1, null, '', { id: 'x' }, 'device-b']),
    });
    expect([...readPersistedIds('key', storage)]).toEqual(['device-a', 'device-b']);
  });

  test('缺失的键回退为空集合', () => {
    expect(readPersistedIds('missing', createMemoryStorage()).size).toBe(0);
  });

  test('getItem 抛出时回退为空集合', () => {
    const storage: DeviceIdStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
    };
    expect(readPersistedIds('key', storage).size).toBe(0);
  });

  test('storage 不可用时回退为空集合', () => {
    expect(readPersistedIds('key', null).size).toBe(0);
  });
});

describe('writePersistedIds', () => {
  test('写入为 JSON 字符串数组并可回读', () => {
    const storage = createMemoryStorage();
    writePersistedIds(CONNECTED_STORAGE_KEY, new Set(['device-a', 'device-b']), storage);
    expect(storage.entries.get(CONNECTED_STORAGE_KEY)).toBe('["device-a","device-b"]');
    expect([...readPersistedIds(CONNECTED_STORAGE_KEY, storage)]).toEqual(['device-a', 'device-b']);
  });

  test('空集合写入为空数组', () => {
    const storage = createMemoryStorage();
    writePersistedIds('key', new Set<string>(), storage);
    expect(storage.entries.get('key')).toBe('[]');
  });

  test('setItem 抛出（配额 / 隐私模式）时不向外抛出', () => {
    const storage: DeviceIdStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => writePersistedIds('key', new Set(['device-a']), storage)).not.toThrow();
  });

  test('storage 不可用时不抛出', () => {
    expect(() => writePersistedIds('key', new Set(['device-a']), null)).not.toThrow();
  });
});

describe('pruneUnknownDeviceIds', () => {
  test('删除已不存在的设备 ID 并返回新集合', () => {
    const ids = new Set(['device-a', 'deleted']);
    const next = pruneUnknownDeviceIds(ids, new Set(['device-a']));
    expect([...next]).toEqual(['device-a']);
    expect(next).not.toBe(ids);
  });

  test('无变化时返回原引用', () => {
    const ids = new Set(['device-a']);
    expect(pruneUnknownDeviceIds(ids, new Set(['device-a', 'device-b']))).toBe(ids);
  });

  test('已知集合为空时清空全部', () => {
    expect(pruneUnknownDeviceIds(new Set(['device-a']), new Set()).size).toBe(0);
  });
});

describe('withDeviceId / withoutDeviceId', () => {
  test('新增不存在的 ID 返回新集合', () => {
    const ids = new Set(['device-a']);
    const next = withDeviceId(ids, 'device-b');
    expect(next && [...next]).toEqual(['device-a', 'device-b']);
    expect(ids.has('device-b')).toBe(false);
  });

  test('新增已存在的 ID 返回 null 表示无变化', () => {
    expect(withDeviceId(new Set(['device-a']), 'device-a')).toBeNull();
  });

  test('移除存在的 ID 返回新集合', () => {
    const ids = new Set(['device-a', 'device-b']);
    const next = withoutDeviceId(ids, 'device-a');
    expect(next && [...next]).toEqual(['device-b']);
    expect(ids.has('device-a')).toBe(true);
  });

  test('移除不存在的 ID 返回 null 表示无变化', () => {
    expect(withoutDeviceId(new Set(['device-a']), 'device-b')).toBeNull();
  });
});
