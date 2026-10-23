import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { dispatchRoutes } from '../api/route';
import { getDb as getOrmDb } from '../db/client';
import { getGatewayKv } from '../db/kv';
import { gatewayKv } from '../db/schema';
import {
  MESH_PROXY_KV_KEY,
  getMeshProxyStore,
  resetMeshProxyStoreForTests,
} from '../mesh/mesh-proxy-store';
import { type SettingsNamespace, registerSettingsBroadcaster } from './broadcaster';
import {
  INVALID_MESH_PROXY_MODE,
  MESH_PROXY_SETTINGS_PATH,
  type MeshProxyModeResponse,
  meshProxySettingsRoutes,
} from './mesh-proxy';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

afterEach(() => {
  registerSettingsBroadcaster(null);
  resetMeshProxyStoreForTests();
  getOrmDb().delete(gatewayKv).where(eq(gatewayKv.key, MESH_PROXY_KV_KEY)).run();
});

async function call(method: 'GET' | 'PUT', body?: unknown): Promise<Response> {
  const req = new Request(`http://localhost${MESH_PROXY_SETTINGS_PATH}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const res = dispatchRoutes(req, MESH_PROXY_SETTINGS_PATH, meshProxySettingsRoutes, {
    path: MESH_PROXY_SETTINGS_PATH,
  });
  if (!res) throw new Error('route not matched');
  return res;
}

describe('/api/settings/mesh-proxy', () => {
  test('GET 缺省回 direct', async () => {
    const res = await call('GET');
    expect(res.status).toBe(200);
    expect((await res.json()) as MeshProxyModeResponse).toEqual({ meshProxy: 'direct' });
  });

  test('PUT 落库并回读，订阅者与 SETTINGS_UPDATE 同步收到变更', async () => {
    const seen: MeshProxyModeResponse['meshProxy'][] = [];
    const namespaces: SettingsNamespace[] = [];
    const off = getMeshProxyStore().subscribe((mode) => {
      seen.push(mode);
    });
    registerSettingsBroadcaster((namespace) => {
      namespaces.push(namespace);
    });
    const put = await call('PUT', { meshProxy: 'system' });
    expect(put.status).toBe(200);
    expect((await put.json()) as MeshProxyModeResponse).toEqual({ meshProxy: 'system' });
    expect(getGatewayKv(MESH_PROXY_KV_KEY)).toBe('system');
    expect(seen).toEqual(['system']);
    expect(namespaces).toEqual(['mesh-proxy']);
    off();

    resetMeshProxyStoreForTests();
    const get = await call('GET');
    expect((await get.json()) as MeshProxyModeResponse).toEqual({ meshProxy: 'system' });
  });

  test('非法 meshProxy 回 400 INVALID_MESH_PROXY_MODE 且不落库', async () => {
    const res = await call('PUT', { meshProxy: 'off' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: { code: string } };
    expect(body.code).toBe(INVALID_MESH_PROXY_MODE);
    expect(body.error.code).toBe(INVALID_MESH_PROXY_MODE);
    expect(getGatewayKv(MESH_PROXY_KV_KEY)).toBeNull();
  });

  test('缺 body 或 meshProxy 非字符串回 400', async () => {
    expect((await call('PUT', {})).status).toBe(400);
    expect((await call('PUT', { meshProxy: 1 })).status).toBe(400);
    expect((await call('PUT', { mode: 'direct' })).status).toBe(400);
  });
});
