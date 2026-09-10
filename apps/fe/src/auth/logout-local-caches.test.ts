import { describe, expect, it } from 'bun:test';
import { tmuxTopologyCacheKey } from '@vibeterm/stores';
import { clearLocalDeviceCaches } from './logout-local-caches';

function fakeStorage(entries: Record<string, string>): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

describe('clearLocalDeviceCaches', () => {
  it('清掉 self 与各 node 前缀的拓扑缓存，不动其它键', () => {
    const storage = fakeStorage({
      [tmuxTopologyCacheKey('')]: '{}',
      [tmuxTopologyCacheKey('n:abc:')]: '{}',
      'vibeterm:mesh-nodes': '{}',
      'vibeterm-ui': '{}',
    });
    clearLocalDeviceCaches(storage);
    expect(storage.getItem(tmuxTopologyCacheKey(''))).toBeNull();
    expect(storage.getItem(tmuxTopologyCacheKey('n:abc:'))).toBeNull();
    expect(storage.getItem('vibeterm:mesh-nodes')).toBe('{}');
    expect(storage.getItem('vibeterm-ui')).toBe('{}');
  });

  it('设备快照与索引一并清掉（它是设备列表的首帧占位，换账号后不能留）', () => {
    const storage = fakeStorage({
      'vibeterm:device-snapshot:self': '[]',
      'vibeterm:device-snapshot:0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a': '[]',
      'vibeterm:device-snapshot-index': '{}',
      // 改名前的旧键同样清掉
      'tmex:device-snapshot:self': '[]',
      'tmex:device-snapshot-index': '{}',
      'vibeterm-ui': '{}',
    });
    clearLocalDeviceCaches(storage);
    expect(storage.getItem('vibeterm:device-snapshot:self')).toBeNull();
    expect(storage.getItem('vibeterm:device-snapshot:0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a')).toBeNull();
    expect(storage.getItem('vibeterm:device-snapshot-index')).toBeNull();
    expect(storage.getItem('tmex:device-snapshot:self')).toBeNull();
    expect(storage.getItem('tmex:device-snapshot-index')).toBeNull();
    expect(storage.getItem('vibeterm-ui')).toBe('{}');
  });

  it('没有存储时静默返回', () => {
    expect(() => clearLocalDeviceCaches(null)).not.toThrow();
  });
});
