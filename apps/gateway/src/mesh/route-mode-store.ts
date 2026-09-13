// 多节点互联「延迟优化」选路模式：gateway_kv 持久化，进程内订阅热更新。
// HTTP 与 mesh runtime 共用同一实例，WPR1 从 `deps.routeMode.get()` / `subscribe` 读取。

import { DEFAULT_MESH_ROUTE_MODE, type MeshRouteMode, isMeshRouteMode } from '@vibeterm/shared/net';
import { getGatewayKv, setGatewayKv } from '../db/kv';

export const MESH_ROUTE_MODE_KV_KEY = 'mesh.routeMode';

export type MeshRouteModeKv = {
  get(key: string): string | null;
  set(key: string, value: string): void;
};

export type MeshRouteModeStore = {
  get(): MeshRouteMode;
  set(mode: MeshRouteMode): void;
  subscribe(fn: (mode: MeshRouteMode) => void): () => void;
};

export function createMeshRouteModeStore(kv: MeshRouteModeKv): MeshRouteModeStore {
  const listeners = new Set<(mode: MeshRouteMode) => void>();
  let cached: MeshRouteMode | null = null;

  function read(): MeshRouteMode {
    if (cached !== null) return cached;
    let raw: string | null = null;
    try {
      raw = kv.get(MESH_ROUTE_MODE_KV_KEY);
    } catch {
      raw = null;
    }
    cached = isMeshRouteMode(raw) ? raw : DEFAULT_MESH_ROUTE_MODE;
    return cached;
  }

  return {
    get: read,
    set(mode) {
      const prev = read();
      kv.set(MESH_ROUTE_MODE_KV_KEY, mode);
      cached = mode;
      if (mode === prev) return;
      for (const fn of listeners) fn(mode);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

let singleton: MeshRouteModeStore | null = null;

/** HTTP 与 mesh runtime 共用的进程内单例。 */
export function getMeshRouteModeStore(): MeshRouteModeStore {
  singleton ??= createMeshRouteModeStore({
    get: getGatewayKv,
    set: setGatewayKv,
  });
  return singleton;
}

export function resetMeshRouteModeStoreForTests(): void {
  singleton = null;
}
