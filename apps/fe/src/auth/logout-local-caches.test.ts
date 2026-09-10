import { describe, expect, it } from 'bun:test';
import { tmuxTopologyCacheKey } from '@vibeterm/stores';
import { clearLocalTopologyCaches } from './logout-local-caches';

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

describe('clearLocalTopologyCaches', () => {
  it('清掉 self 与各 node 前缀的拓扑缓存，不动其它键', () => {
    const storage = fakeStorage({
      [tmuxTopologyCacheKey('')]: '{}',
      [tmuxTopologyCacheKey('n:abc:')]: '{}',
      'vibeterm:mesh-nodes': '{}',
      'vibeterm-ui': '{}',
    });
    clearLocalTopologyCaches(storage);
    expect(storage.getItem(tmuxTopologyCacheKey(''))).toBeNull();
    expect(storage.getItem(tmuxTopologyCacheKey('n:abc:'))).toBeNull();
    expect(storage.getItem('vibeterm:mesh-nodes')).toBe('{}');
    expect(storage.getItem('vibeterm-ui')).toBe('{}');
  });

  it('没有存储时静默返回', () => {
    expect(() => clearLocalTopologyCaches(null)).not.toThrow();
  });
});
