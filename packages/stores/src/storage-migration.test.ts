import { describe, expect, test } from 'bun:test';
import { type SyncKeyValueStorage, migrateStorageKey } from './storage-migration';

function memoryStorage(initial: Record<string, string> = {}): SyncKeyValueStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

describe('migrateStorageKey', () => {
  test('旧键搬到新键后删除旧键', () => {
    const storage = memoryStorage({ 'tmex-ui': '{"a":1}' });
    migrateStorageKey(storage, 'tmex-ui', 'vibeterm-ui');
    expect(storage.data).toEqual({ 'vibeterm-ui': '{"a":1}' });
  });

  test('新键已有值时保留新值，仍清掉旧键', () => {
    const storage = memoryStorage({ 'tmex-ui': 'old', 'vibeterm-ui': 'new' });
    migrateStorageKey(storage, 'tmex-ui', 'vibeterm-ui');
    expect(storage.data).toEqual({ 'vibeterm-ui': 'new' });
  });

  test('旧键不存在时不写新键', () => {
    const storage = memoryStorage();
    migrateStorageKey(storage, 'tmex-ui', 'vibeterm-ui');
    expect(storage.data).toEqual({});
  });

  test('重复调用幂等', () => {
    const storage = memoryStorage({ 'tmex-ui': 'v' });
    migrateStorageKey(storage, 'tmex-ui', 'vibeterm-ui');
    storage.setItem('vibeterm-ui', 'v2');
    migrateStorageKey(storage, 'tmex-ui', 'vibeterm-ui');
    expect(storage.data).toEqual({ 'vibeterm-ui': 'v2' });
  });

  test('存储抛异常时静默降级', () => {
    const throwing: SyncKeyValueStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(() => migrateStorageKey(throwing, 'a', 'b')).not.toThrow();
    expect(() => migrateStorageKey(null, 'a', 'b')).not.toThrow();
  });
});
