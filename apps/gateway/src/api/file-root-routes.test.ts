import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { Device, FileRootDto } from '@tmex/shared';
import { createDevice } from '../db/devices';
import { createFileRoot, deleteFileRoot } from '../db/file-roots';
import { runMigrations } from '../db/migrate';
import { t } from '../i18n';
import { type SettingsNamespace, registerSettingsBroadcaster } from '../settings/broadcaster';
import { fileRootRoutes } from './file-root-routes';
import { dispatchRoutes } from './route';

beforeAll(() => {
  runMigrations();
});

const createdRootIds: string[] = [];

afterEach(() => {
  registerSettingsBroadcaster(null);
  for (const id of createdRootIds) deleteFileRoot(id);
  createdRootIds.length = 0;
});

function makeDevice(id: string): Device {
  const now = new Date().toISOString();
  return {
    id,
    name: `dev-${id}`,
    type: 'local',
    session: 'tmex',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function call(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const pathname = new URL(req.url).pathname;
  const response = dispatchRoutes(req, pathname, fileRootRoutes, {
    server: {} as never,
    path: pathname,
  });
  if (!response) {
    throw new Error(`no route matched: ${method} ${path}`);
  }
  const resolved = await response;
  return { status: resolved.status, json: (await resolved.json()) as Record<string, unknown> };
}

describe('PUT /api/files/roots/order', () => {
  test('按 rootIds 重排并返回新顺序的 roots', async () => {
    const deviceId = `g1-api-order-${crypto.randomUUID().slice(0, 8)}`;
    createDevice(makeDevice(deviceId));
    const roots = ['/g1/api/a', '/g1/api/b', '/g1/api/c'].map((path) =>
      createFileRoot({ deviceId, path })
    );
    createdRootIds.push(...roots.map((row) => row.id));
    const ids = roots.map((row) => row.id);
    const received: SettingsNamespace[] = [];
    registerSettingsBroadcaster((namespace) => received.push(namespace));

    const { status, json } = await call('PUT', '/api/files/roots/order', {
      rootIds: [ids[2], ids[0], ids[1]],
    });

    expect(status).toBe(200);
    const body = json as { roots: FileRootDto[] };
    const mine = body.roots.filter((row) => ids.includes(row.id));
    expect(mine.map((row) => row.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(mine.map((row) => row.sortOrder)).toEqual([0, 1, 2]);
    expect(mine[0]?.name).toBe('c');
    expect(mine[0]?.deviceId).toBe(deviceId);
    expect(mine[0]?.deviceName).toBe(`dev-${deviceId}`);
    expect(mine[0]?.deviceType).toBe('local');
    expect(received).toEqual(['file-roots']);
  });

  test('部分列表 + 未知 id：命中项在前，其余相对顺序跟在后面', async () => {
    const deviceId = `g1-api-partial-${crypto.randomUUID().slice(0, 8)}`;
    createDevice(makeDevice(deviceId));
    const roots = ['/g1/api/p/a', '/g1/api/p/b', '/g1/api/p/c', '/g1/api/p/d'].map((path) =>
      createFileRoot({ deviceId, path })
    );
    createdRootIds.push(...roots.map((row) => row.id));
    const [a, b, c, d] = roots.map((row) => row.id);

    const { status, json } = await call('PUT', '/api/files/roots/order', {
      rootIds: ['missing-root', c, a],
    });

    expect(status).toBe(200);
    const mine = (json as { roots: FileRootDto[] }).roots.filter((row) =>
      [a, b, c, d].includes(row.id)
    );
    expect(mine.map((row) => row.id)).toEqual([c, a, b, d]);
  });

  test('非法 body 返回 400 invalidRequest', async () => {
    const invalidBodies: unknown[] = [
      null,
      [],
      {},
      { rootIds: 'a' },
      { rootIds: [1] },
      { rootIds: [''] },
      { rootIds: ['ok', ''] },
      { rootIds: ['dup', 'dup'] },
      { rootIds: [] },
      { rootIds: ['no-such-root'] },
    ];
    for (const body of invalidBodies) {
      const { status, json } = await call('PUT', '/api/files/roots/order', body);
      expect(status).toBe(400);
      expect(json).toEqual({ error: t('apiError.invalidRequest') });
    }
  });
});
