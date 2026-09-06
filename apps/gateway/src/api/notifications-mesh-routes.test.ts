import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { MESH_NOTIFICATION_ROUTE, type MeshNotificationState } from '@tmex/shared';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb as getOrmDb } from '../db/client';
import { setMeshNotificationBridge } from '../mesh/notification-mesh-bridge';
import {
  resetMeshNotificationSinkCache,
  setMeshNotificationSinkEnabled,
} from '../mesh/notification-sink-state';
import { notificationsMeshRoutes } from './notifications-mesh-routes';
import { dispatchRoutes } from './route';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

afterEach(() => {
  setMeshNotificationBridge(null);
  setMeshNotificationSinkEnabled(false);
  resetMeshNotificationSinkCache();
});

async function call(method: 'GET' | 'PUT', body?: unknown): Promise<Response> {
  const req = new Request(`http://localhost${MESH_NOTIFICATION_ROUTE}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const res = dispatchRoutes(req, MESH_NOTIFICATION_ROUTE, notificationsMeshRoutes, {
    path: MESH_NOTIFICATION_ROUTE,
  });
  if (!res) throw new Error('route not matched');
  return res;
}

describe('/api/notifications/mesh', () => {
  test('没有 mesh 时 supported=false、集合为空', async () => {
    const state = (await (await call('GET')).json()) as MeshNotificationState;
    expect(state.supported).toBe(false);
    expect(state.sinks).toEqual([]);
    expect(state.selfEnabled).toBe(false);
  });

  test('PUT 落库并回读，状态带本机节点编号', async () => {
    setMeshNotificationBridge({
      selfNodeId: () => 'node-a',
      selfName: () => 'A',
      selfSinkEnabled: () => true,
      sinkAuthorized: () => true,
      listSinks: () => [{ nodeId: 'node-a', name: 'A', self: true, online: true }],
      deliver: async () => new Response('{}'),
    });
    const put = (await (await call('PUT', { enabled: true })).json()) as MeshNotificationState;
    expect(put.supported).toBe(true);
    expect(put.selfEnabled).toBe(true);
    expect(put.sinks).toEqual([{ nodeId: 'node-a', name: 'A', self: true, online: true }]);
    // 前端签 `notification-sink` 记录时要按这个编号写 payload。
    expect(put.selfNodeId).toBe('node-a');

    resetMeshNotificationSinkCache();
    const get = (await (await call('GET')).json()) as MeshNotificationState;
    expect(get.selfEnabled).toBe(true);
  });

  test('body 缺 enabled 回 400', async () => {
    expect((await call('PUT', {})).status).toBe(400);
    expect((await call('PUT', { enabled: 'yes' })).status).toBe(400);
  });

  test('队列统计随响应下发', async () => {
    const state = (await (await call('GET')).json()) as MeshNotificationState;
    expect(state.forwardQueue).toEqual({ pending: 0, dropped: 0 });
  });
});
