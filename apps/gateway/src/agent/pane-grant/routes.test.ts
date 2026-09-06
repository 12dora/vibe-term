import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { dispatchRoutes } from '../../api/route';
import { getDb } from '../../db/client';
import { createDevice } from '../../db/devices';
import { runMigrations } from '../../db/migrate';
import { agentPaneGrants } from '../../db/schema';
import { X_TMEX_MESH_PEER } from '../../mesh/peer-request-marker';
import { PANE_GRANT_ROUTE, paneGrantRoutes } from './routes';
import { getPaneGrant, issuePaneGrant } from './store';

const NODE_X = 'a'.repeat(32);
const NODE_Z = 'c'.repeat(32);
const DEVICE = 'pane-grant-route-device';

beforeAll(() => {
  runMigrations();
  const now = new Date().toISOString();
  createDevice({
    id: DEVICE,
    name: 'grant-route-device',
    type: 'local',
    session: 'tmex-test',
    authMode: 'agent',
    port: 22,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });
});

beforeEach(() => {
  getDb().delete(agentPaneGrants).run();
});

async function call(
  method: string,
  path: string,
  options: { body?: unknown; peer?: string } = {}
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.peer) headers[X_TMEX_MESH_PEER] = options.peer;
  const req = new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const res = await dispatchRoutes(req, path, paneGrantRoutes, { path });
  if (!res) throw new Error(`no route for ${method} ${path}`);
  const resolved = await res;
  return { status: resolved.status, json: (await resolved.json()) as Record<string, unknown> };
}

describe('POST /api/agent/pane-grants', () => {
  test('浏览器直连签发：请求体里的 fromNodeId 生效', async () => {
    const res = await call('POST', PANE_GRANT_ROUTE, {
      body: { fromNodeId: NODE_X, deviceId: DEVICE, paneId: '%1' },
    });
    expect(res.status).toBe(201);
    expect(typeof res.json.grantId).toBe('string');
    expect(typeof res.json.token).toBe('string');
    expect(getPaneGrant(res.json.grantId as string)).toMatchObject({
      fromNodeId: NODE_X,
      deviceId: DEVICE,
      paneId: '%1',
    });
  });

  test('经 mesh 转发：授权绑到 peer 标记，请求体不一致直接拒', async () => {
    const bound = await call('POST', PANE_GRANT_ROUTE, {
      peer: NODE_X,
      body: { deviceId: DEVICE, paneId: '%2' },
    });
    expect(bound.status).toBe(201);
    expect(getPaneGrant(bound.json.grantId as string)?.fromNodeId).toBe(NODE_X);

    const mismatch = await call('POST', PANE_GRANT_ROUTE, {
      peer: NODE_X,
      body: { fromNodeId: NODE_Z, deviceId: DEVICE, paneId: '%2' },
    });
    expect(mismatch.status).toBe(400);
  });

  test('fromNodeId 不是 32 位十六进制 / 缺窗格 / 窗格格式非法 → 400', async () => {
    for (const body of [
      { fromNodeId: 'not-a-node', deviceId: DEVICE, paneId: '%1' },
      { deviceId: DEVICE, paneId: '%1' },
      { fromNodeId: NODE_X, deviceId: DEVICE, paneId: '%1 extra' },
      { fromNodeId: NODE_X, deviceId: '', paneId: '%1' },
    ]) {
      expect((await call('POST', PANE_GRANT_ROUTE, { body })).status).toBe(400);
    }
  });

  test('设备不存在 → 404 device_not_found', async () => {
    const res = await call('POST', PANE_GRANT_ROUTE, {
      body: { fromNodeId: NODE_X, deviceId: 'ghost', paneId: '%1' },
    });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('device_not_found');
  });
});

describe('DELETE /api/agent/pane-grants/:id', () => {
  test('吊销后授权即消失，重复吊销 404', async () => {
    const issued = issuePaneGrant({ fromNodeId: NODE_X, deviceId: DEVICE, paneId: '%3' });
    expect((await call('DELETE', `${PANE_GRANT_ROUTE}/${issued.grantId}`)).status).toBe(200);
    expect(getPaneGrant(issued.grantId)).toBeNull();
    expect((await call('DELETE', `${PANE_GRANT_ROUTE}/${issued.grantId}`)).status).toBe(404);
  });
});
