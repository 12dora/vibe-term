// mesh / 中继 / 对端出站代理策略：gateway_kv 持久化，进程内订阅热更新。
// HTTP 与 meshFetch / meshWebSocket 共用同一实例；改值不拆已建链路。

import { DEFAULT_MESH_PROXY_MODE, type MeshProxyMode, isMeshProxyMode } from '@vibeterm/shared/net';
import { getGatewayKv, setGatewayKv } from '../db/kv';

export const MESH_PROXY_KV_KEY = 'mesh.proxy';

export type MeshProxyKv = {
  get(key: string): string | null;
  set(key: string, value: string): void;
};

export type MeshProxyStore = {
  get(): MeshProxyMode;
  set(mode: MeshProxyMode): void;
  subscribe(fn: (mode: MeshProxyMode) => void): () => void;
};

export function createMeshProxyStore(kv: MeshProxyKv): MeshProxyStore {
  const listeners = new Set<(mode: MeshProxyMode) => void>();
  let cached: MeshProxyMode | null = null;

  function read(): MeshProxyMode {
    if (cached !== null) return cached;
    let raw: string | null = null;
    try {
      raw = kv.get(MESH_PROXY_KV_KEY);
    } catch {
      raw = null;
    }
    cached = isMeshProxyMode(raw) ? raw : DEFAULT_MESH_PROXY_MODE;
    return cached;
  }

  return {
    get: read,
    set(mode) {
      const prev = read();
      kv.set(MESH_PROXY_KV_KEY, mode);
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

let singleton: MeshProxyStore | null = null;

/** HTTP 与 mesh 出站共用的进程内单例。 */
export function getMeshProxyStore(): MeshProxyStore {
  singleton ??= createMeshProxyStore({
    get: getGatewayKv,
    set: setGatewayKv,
  });
  return singleton;
}

export function resetMeshProxyStoreForTests(): void {
  singleton = null;
}
