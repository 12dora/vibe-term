import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { dispatchRoutes } from '../api/route';
import { getDb as getOrmDb } from '../db/client';
import { getGatewayKv } from '../db/kv';
import { gatewayKv } from '../db/schema';
import {
  MESH_ROUTE_MODE_KV_KEY,
  getMeshRouteModeStore,
  resetMeshRouteModeStoreForTests,
} from '../mesh/route-mode-store';
import {
  INVALID_MESH_ROUTE_MODE,
  MESH_ROUTE_SETTINGS_PATH,
  type MeshRouteModeResponse,
  meshRouteSettingsRoutes,
} from './mesh-route';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

afterEach(() => {
  resetMeshRouteModeStoreForTests();
  getOrmDb().delete(gatewayKv).where(eq(gatewayKv.key, MESH_ROUTE_MODE_KV_KEY)).run();
});

async function call(method: 'GET' | 'PUT', body?: unknown): Promise<Response> {
  const req = new Request(`http://localhost${MESH_ROUTE_SETTINGS_PATH}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const res = dispatchRoutes(req, MESH_ROUTE_SETTINGS_PATH, meshRouteSettingsRoutes, {
    path: MESH_ROUTE_SETTINGS_PATH,
  });
  if (!res) throw new Error('route not matched');
  return res;
}

describe('/api/settings/mesh-route', () => {
  test('GET 缺省回 auto', async () => {
    const res = await call('GET');
    expect(res.status).toBe(200);
    expect((await res.json()) as MeshRouteModeResponse).toEqual({ mode: 'auto' });
  });

  test('PUT 落库并回读，订阅者同步收到变更', async () => {
    const seen: string[] = [];
    const off = getMeshRouteModeStore().subscribe((mode) => {
      seen.push(mode);
    });
    const put = await call('PUT', { mode: 'relay' });
    expect(put.status).toBe(200);
    expect((await put.json()) as MeshRouteModeResponse).toEqual({ mode: 'relay' });
    expect(getGatewayKv(MESH_ROUTE_MODE_KV_KEY)).toBe('relay');
    expect(seen).toEqual(['relay']);
    off();

    resetMeshRouteModeStoreForTests();
    const get = await call('GET');
    expect((await get.json()) as MeshRouteModeResponse).toEqual({ mode: 'relay' });
  });

  test('非法 mode 回 400 INVALID_MESH_ROUTE_MODE 且不落库', async () => {
    const res = await call('PUT', { mode: 'fastest' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: { code: string } };
    expect(body.code).toBe(INVALID_MESH_ROUTE_MODE);
    expect(body.error.code).toBe(INVALID_MESH_ROUTE_MODE);
    expect(getGatewayKv(MESH_ROUTE_MODE_KV_KEY)).toBeNull();
  });

  test('缺 body 或 mode 非字符串回 400', async () => {
    expect((await call('PUT', {})).status).toBe(400);
    expect((await call('PUT', { mode: 1 })).status).toBe(400);
  });
});
