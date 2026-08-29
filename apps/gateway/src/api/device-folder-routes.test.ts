import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { DEVICE_FOLDER_NAME_MAX_LENGTH, type DeviceFolderLayout } from '@tmex/shared';
import type { Server } from 'bun';
import { ensureSiteSettingsInitialized } from '../db';
import { runMigrations } from '../db/migrate';
import { t } from '../i18n';
import { type SettingsNamespace, registerSettingsBroadcaster } from '../settings/broadcaster';
import { deviceFolderRoutes } from './device-folder-routes';
import { handleApiRequest } from './index';
import { dispatchRoutes } from './route';

beforeAll(() => {
  runMigrations();
  ensureSiteSettingsInitialized();
});

afterEach(() => {
  registerSettingsBroadcaster(null);
});

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
  const response = dispatchRoutes(req, pathname, deviceFolderRoutes, {
    server: {} as never,
    path: pathname,
  });
  if (!response) {
    throw new Error(`no route matched: ${method} ${path}`);
  }
  const resolved = await response;
  return { status: resolved.status, json: (await resolved.json()) as Record<string, unknown> };
}

async function getLayout(): Promise<DeviceFolderLayout> {
  const { status, json } = await call('GET', '/api/device-folders');
  expect(status).toBe(200);
  return json as unknown as DeviceFolderLayout;
}

describe('POST /api/device-folders', () => {
  test('创建成功返回 201', async () => {
    const received: SettingsNamespace[] = [];
    registerSettingsBroadcaster((namespace) => received.push(namespace));
    const { status, json } = await call('POST', '/api/device-folders', { name: '  运维 组 ' });
    expect(status).toBe(201);
    const folder = json.folder as { name: string; parentId: string | null; id: string };
    expect(folder.name).toBe('运维 组');
    expect(folder.parentId).toBeNull();
    expect(folder.id.length).toBeGreaterThan(0);
    expect(received).toEqual(['device-folders']);
  });

  test('空名返回 400', async () => {
    const { status, json } = await call('POST', '/api/device-folders', { name: '   ' });
    expect(status).toBe(400);
    expect(json).toEqual({ error: t('apiError.folderNameRequired') });
  });

  test('超长名返回 400', async () => {
    const { status, json } = await call('POST', '/api/device-folders', {
      name: 'x'.repeat(DEVICE_FOLDER_NAME_MAX_LENGTH + 1),
    });
    expect(status).toBe(400);
    expect(json).toEqual({ error: t('apiError.folderNameTooLong') });
  });
});

describe('PATCH /api/device-folders/:id', () => {
  test('改名成功', async () => {
    const created = await call('POST', '/api/device-folders', { name: 'old-name' });
    const id = (created.json.folder as { id: string }).id;
    const { status, json } = await call('PATCH', `/api/device-folders/${id}`, { name: 'new-name' });
    expect(status).toBe(200);
    expect((json.folder as { name: string }).name).toBe('new-name');
  });

  test('把文件夹挂到自己的子文件夹下成环 400', async () => {
    const parent = await call('POST', '/api/device-folders', { name: 'cycle-parent' });
    const parentId = (parent.json.folder as { id: string }).id;
    const child = await call('POST', '/api/device-folders', {
      name: 'cycle-child',
      parentId,
    });
    const childId = (child.json.folder as { id: string }).id;
    const { status, json } = await call('PATCH', `/api/device-folders/${parentId}`, {
      parentId: childId,
    });
    expect(status).toBe(400);
    expect(json).toEqual({ error: t('apiError.folderCycle') });
  });
});

describe('DELETE /api/device-folders/:id', () => {
  test('删除后子文件夹与 placement 上提到父级', async () => {
    const root = await call('POST', '/api/device-folders', { name: 'del-root' });
    const rootId = (root.json.folder as { id: string }).id;
    const mid = await call('POST', '/api/device-folders', { name: 'del-mid', parentId: rootId });
    const midId = (mid.json.folder as { id: string }).id;
    const nested = await call('POST', '/api/device-folders', {
      name: 'del-nested',
      parentId: midId,
    });
    const nestedId = (nested.json.folder as { id: string }).id;

    const layout = await getLayout();
    await call('PUT', '/api/device-folders/layout', {
      folders: layout.folders.map((folder) => ({
        id: folder.id,
        parentId: folder.parentId,
        sortOrder: folder.sortOrder,
      })),
      placements: [
        ...layout.placements,
        {
          kind: 'device',
          nodeId: 'self',
          deviceId: 'del-dev',
          folderId: midId,
          sortOrder: 0,
        },
      ],
    });

    const { status, json } = await call('DELETE', `/api/device-folders/${midId}`);
    expect(status).toBe(200);
    expect(json).toEqual({ success: true });

    const after = await getLayout();
    expect(after.folders.some((folder) => folder.id === midId)).toBe(false);
    expect(after.folders.find((folder) => folder.id === nestedId)?.parentId).toBe(rootId);
    expect(
      after.placements.find((item) => item.kind === 'device' && item.deviceId === 'del-dev')
        ?.folderId
    ).toBe(rootId);
  });
});

describe('PUT /api/device-folders/layout', () => {
  test('成功替换层级', async () => {
    const a = await call('POST', '/api/device-folders', { name: 'layout-a' });
    const b = await call('POST', '/api/device-folders', { name: 'layout-b' });
    const aId = (a.json.folder as { id: string }).id;
    const bId = (b.json.folder as { id: string }).id;
    const layout = await getLayout();
    const { status, json } = await call('PUT', '/api/device-folders/layout', {
      folders: layout.folders.map((folder) =>
        folder.id === bId
          ? { id: bId, parentId: aId, sortOrder: 0 }
          : { id: folder.id, parentId: folder.parentId, sortOrder: folder.sortOrder }
      ),
      placements: layout.placements,
    });
    expect(status).toBe(200);
    const next = json as unknown as DeviceFolderLayout;
    expect(next.folders.find((folder) => folder.id === bId)?.parentId).toBe(aId);
  });

  test('id 集合不一致 400', async () => {
    await call('POST', '/api/device-folders', { name: 'layout-mismatch' });
    const layout = await getLayout();
    const { status, json } = await call('PUT', '/api/device-folders/layout', {
      folders: layout.folders.slice(1).map((folder) => ({
        id: folder.id,
        parentId: folder.parentId,
        sortOrder: folder.sortOrder,
      })),
      placements: [],
    });
    expect(status).toBe(400);
    expect(json).toEqual({ error: t('apiError.folderLayoutInvalid') });
  });

  test('成环 400', async () => {
    const a = await call('POST', '/api/device-folders', { name: 'cycle-a' });
    const b = await call('POST', '/api/device-folders', { name: 'cycle-b' });
    const aId = (a.json.folder as { id: string }).id;
    const bId = (b.json.folder as { id: string }).id;
    const layout = await getLayout();
    const { status, json } = await call('PUT', '/api/device-folders/layout', {
      folders: layout.folders.map((folder) => {
        if (folder.id === aId) return { id: aId, parentId: bId, sortOrder: 0 };
        if (folder.id === bId) return { id: bId, parentId: aId, sortOrder: 0 };
        return { id: folder.id, parentId: folder.parentId, sortOrder: folder.sortOrder };
      }),
      placements: layout.placements,
    });
    expect(status).toBe(400);
    expect(json).toEqual({ error: t('apiError.folderCycle') });
  });

  test('非法 placement 400', async () => {
    const layout = await getLayout();
    const folders = layout.folders.map((folder) => ({
      id: folder.id,
      parentId: folder.parentId,
      sortOrder: folder.sortOrder,
    }));
    const badKind = await call('PUT', '/api/device-folders/layout', {
      folders,
      placements: [{ kind: 'folder', nodeId: 'n1', deviceId: null, folderId: null, sortOrder: 0 }],
    });
    expect(badKind.status).toBe(400);
    expect(badKind.json).toEqual({ error: t('apiError.folderLayoutInvalid') });

    const missingDeviceId = await call('PUT', '/api/device-folders/layout', {
      folders,
      placements: [
        { kind: 'device', nodeId: 'self', deviceId: null, folderId: null, sortOrder: 0 },
      ],
    });
    expect(missingDeviceId.status).toBe(400);

    const dup = await call('PUT', '/api/device-folders/layout', {
      folders,
      placements: [
        { kind: 'node', nodeId: 'n-dup', deviceId: null, folderId: null, sortOrder: 0 },
        { kind: 'node', nodeId: 'n-dup', deviceId: null, folderId: null, sortOrder: 1 },
      ],
    });
    expect(dup.status).toBe(400);
    expect(dup.json).toEqual({ error: t('apiError.folderLayoutInvalid') });
  });
});

describe('GET /api/device-folders', () => {
  test('返回 folders 与 placements 数组', async () => {
    const { status, json } = await call('GET', '/api/device-folders');
    expect(status).toBe(200);
    expect(Array.isArray(json.folders)).toBe(true);
    expect(Array.isArray(json.placements)).toBe(true);
  });
});

describe('handleApiRequest 路由可达', () => {
  test('GET /api/device-folders 命中生产路由表', async () => {
    const res = await handleApiRequest(
      new Request('http://localhost/api/device-folders'),
      {} as Server<unknown>
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { folders: unknown; placements: unknown };
    expect(Array.isArray(body.folders)).toBe(true);
    expect(Array.isArray(body.placements)).toBe(true);
  });

  test('PUT /api/device-folders/layout 不被 :id 吃掉', async () => {
    const layout = await getLayout();
    const res = await handleApiRequest(
      new Request('http://localhost/api/device-folders/layout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folders: layout.folders.map((folder) => ({
            id: folder.id,
            parentId: folder.parentId,
            sortOrder: folder.sortOrder,
          })),
          placements: layout.placements,
        }),
      }),
      {} as Server<unknown>
    );
    expect(res.status).toBe(200);
  });
});
