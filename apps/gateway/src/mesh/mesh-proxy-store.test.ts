import { describe, expect, test } from 'bun:test';
import { DEFAULT_MESH_PROXY_MODE, type MeshProxyMode } from '@vibeterm/shared/net';
import { MESH_PROXY_KV_KEY, createMeshProxyStore } from './mesh-proxy-store';

function memoryKv(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    kv: {
      get(key: string): string | null {
        return data.get(key) ?? null;
      },
      set(key: string, value: string): void {
        data.set(key, value);
      },
    },
  };
}

describe('createMeshProxyStore', () => {
  test('缺省与非法落库值都回默认 direct', () => {
    expect(createMeshProxyStore(memoryKv().kv).get()).toBe(DEFAULT_MESH_PROXY_MODE);
    expect(createMeshProxyStore(memoryKv({ [MESH_PROXY_KV_KEY]: 'bogus' }).kv).get()).toBe(
      DEFAULT_MESH_PROXY_MODE
    );
    expect(createMeshProxyStore(memoryKv({ [MESH_PROXY_KV_KEY]: 'auto' }).kv).get()).toBe(
      DEFAULT_MESH_PROXY_MODE
    );
  });

  test('合法落库值原样读出', () => {
    for (const mode of ['direct', 'system'] as const) {
      expect(createMeshProxyStore(memoryKv({ [MESH_PROXY_KV_KEY]: mode }).kv).get()).toBe(mode);
    }
  });

  test('set 写入 kv 并同步通知订阅者；同值不重复触发', () => {
    const { data, kv } = memoryKv();
    const store = createMeshProxyStore(kv);
    const seen: MeshProxyMode[] = [];
    const off = store.subscribe((mode) => {
      seen.push(mode);
    });

    store.set('system');
    expect(store.get()).toBe('system');
    expect(data.get(MESH_PROXY_KV_KEY)).toBe('system');
    expect(seen).toEqual(['system']);

    store.set('system');
    expect(seen).toEqual(['system']);

    store.set('direct');
    expect(seen).toEqual(['system', 'direct']);
    off();
    store.set('system');
    expect(seen).toEqual(['system', 'direct']);
    expect(store.get()).toBe('system');
  });

  test('读 kv 抛错时按默认处理', () => {
    const store = createMeshProxyStore({
      get() {
        throw new Error('kv down');
      },
      set() {},
    });
    expect(store.get()).toBe(DEFAULT_MESH_PROXY_MODE);
  });
});
