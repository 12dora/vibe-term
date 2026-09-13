import { describe, expect, test } from 'bun:test';
import { DEFAULT_MESH_ROUTE_MODE, type MeshRouteMode } from '@vibeterm/shared/net';
import { MESH_ROUTE_MODE_KV_KEY, createMeshRouteModeStore } from './route-mode-store';

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

describe('createMeshRouteModeStore', () => {
  test('缺省与非法落库值都回默认 auto', () => {
    expect(createMeshRouteModeStore(memoryKv().kv).get()).toBe(DEFAULT_MESH_ROUTE_MODE);
    expect(createMeshRouteModeStore(memoryKv({ [MESH_ROUTE_MODE_KV_KEY]: 'bogus' }).kv).get()).toBe(
      DEFAULT_MESH_ROUTE_MODE
    );
    expect(createMeshRouteModeStore(memoryKv({ [MESH_ROUTE_MODE_KV_KEY]: '' }).kv).get()).toBe(
      DEFAULT_MESH_ROUTE_MODE
    );
  });

  test('合法落库值原样读出', () => {
    for (const mode of ['auto', 'direct', 'relay'] as const) {
      expect(createMeshRouteModeStore(memoryKv({ [MESH_ROUTE_MODE_KV_KEY]: mode }).kv).get()).toBe(
        mode
      );
    }
  });

  test('set 写入 kv 并同步通知订阅者；同值不重复触发', () => {
    const { data, kv } = memoryKv();
    const store = createMeshRouteModeStore(kv);
    const seen: MeshRouteMode[] = [];
    const off = store.subscribe((mode) => {
      seen.push(mode);
    });

    store.set('relay');
    expect(store.get()).toBe('relay');
    expect(data.get(MESH_ROUTE_MODE_KV_KEY)).toBe('relay');
    expect(seen).toEqual(['relay']);

    store.set('relay');
    expect(seen).toEqual(['relay']);

    store.set('direct');
    expect(seen).toEqual(['relay', 'direct']);
    off();
    store.set('auto');
    expect(seen).toEqual(['relay', 'direct']);
    expect(store.get()).toBe('auto');
  });

  test('读 kv 抛错时按默认处理', () => {
    const store = createMeshRouteModeStore({
      get() {
        throw new Error('kv down');
      },
      set() {},
    });
    expect(store.get()).toBe(DEFAULT_MESH_ROUTE_MODE);
  });
});
