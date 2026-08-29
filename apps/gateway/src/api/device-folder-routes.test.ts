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

async function createFolder(name: string): Promise<string> {
  const { status, json } = await call('POST', '/api/device-folders', { name });
  expect(status).toBe(201);
  return (json.folder as { id: string }).id;
}

function folderOrder(layout: DeviceFolderLayout) {
  return layout.folders.map((folder) => ({ id: folder.id, sortOrder: folder.sortOrder }));
}

describe('POST /api/device-folders', () => {
  test('创建成功返回 201，且没有 parentId', async () => {
    const received: SettingsNamespace[] = [];
    registerSettingsBroadcaster((namespace) => received.push(namespace));
    const { status, json } = await call('POST', '/api/device-folders', { name: '  运维 组 ' });
    expect(status).toBe(201);
    const folder = json.folder as Record<string, unknown>;
    expect(folder.name).toBe('运维 组');
    expect('parentId' in folder).toBe(false);
    expect(String(folder.id).length).toBeGreaterThan(0);
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

  test('试图嵌套（parentId 非空）返回 folderLayoutInvalid', async () => {
    const parentId = await createFolder('nest-parent');
    const { status, json } = await call('POST', '/api/device-folders', {
      name: 'nest-child',
      parentId,
    });
    expect(status).toBe(400);
    expect(json).toEqual({ error: t('apiError.folderLayoutInvalid') });
  });
});

describe('PATCH /api/device-folders/:id', () => {
  test('改名成功', async () => {
    const id = await createFolder('old-name');
    const { status, json } = await call('PATCH', `/api/device-folders/${id}`, { name: 'new-name' });
    expect(status).toBe(200);
    expect((json.folder as { name: string }).name).toBe('new-name');
  });

  test('试图改 parentId 返回 folderLayoutInvalid', async () => {
    const a = await createFolder('patch-a');
    const b = await createFolder('patch-b');
    const { status, json } = await call('PATCH', `/api/device-folders/${a}`, { parentId: b });
    expect(status).toBe(400);
    expect(json).toEqual({ error: t('apiError.folderLayoutInvalid') });
  });

  test('不存在返回 404', async () => {
    const { status } = await call('PATCH', '/api/device-folders/nope', { name: 'x' });
    expect(status).toBe(404);
  });
});

describe('DELETE /api/device-folders/:id', () => {
  test('删除后其中的节点回到根层', async () => {
    const id = await createFolder('del-group');
    const layout = await getLayout();
    await call('PUT', '/api/device-folders/layout', {
      folders: folderOrder(layout),
      placements: [...layout.placements, { nodeId: 'del-node', folderId: id, sortOrder: 0 }],
    });

    const { status, json } = await call('DELETE', `/api/device-folders/${id}`);
    expect(status).toBe(200);
    expect(json).toEqual({ success: true });

    const after = await getLayout();
    expect(after.folders.some((folder) => folder.id === id)).toBe(false);
    expect(after.placements.find((item) => item.nodeId === 'del-node')?.folderId).toBeNull();
  });
});

describe('PUT /api/device-folders/layout', () => {
  test('成功替换顺序与 placement', async () => {
    const aId = await createFolder('layout-a');
    const bId = await createFolder('layout-b');
    const layout = await getLayout();
    const { status, json } = await call('PUT', '/api/device-folders/layout', {
      folders: layout.folders.map((folder) =>
        folder.id === bId
          ? { id: bId, sortOrder: -1 }
          : { id: folder.id, sortOrder: folder.sortOrder }
      ),
      placements: [{ nodeId: 'layout-node', folderId: aId, sortOrder: 0 }],
    });
    expect(status).toBe(200);
    const next = json as unknown as DeviceFolderLayout;
    expect(next.folders[0]?.id).toBe(bId);
    expect(next.placements).toEqual([{ nodeId: 'layout-node', folderId: aId, sortOrder: 0 }]);
  });

  test('id 集合不一致 400', async () => {
    await createFolder('layout-mismatch');
    const layout = await getLayout();
    const { status, json } = await call('PUT', '/api/device-folders/layout', {
      folders: folderOrder(layout).slice(1),
      placements: [],
    });
    expect(status).toBe(400);
    expect(json).toEqual({ error: t('apiError.folderLayoutInvalid') });
  });

  test('嵌套分组 400', async () => {
    const aId = await createFolder('nest-a');
    const bId = await createFolder('nest-b');
    const layout = await getLayout();
    const { status, json } = await call('PUT', '/api/device-folders/layout', {
      folders: folderOrder(layout).map((folder) =>
        folder.id === aId ? { ...folder, parentId: bId } : folder
      ),
      placements: layout.placements,
    });
    expect(status).toBe(400);
    expect(json).toEqual({ error: t('apiError.folderLayoutInvalid') });
  });

  test('设备 placement / 非法 placement 400', async () => {
    const layout = await getLayout();
    const folders = folderOrder(layout);
    const devicePlacement = await call('PUT', '/api/device-folders/layout', {
      folders,
      placements: [
        { kind: 'device', nodeId: 'self', deviceId: 'd1', folderId: null, sortOrder: 0 },
      ],
    });
    expect(devicePlacement.status).toBe(400);
    expect(devicePlacement.json).toEqual({ error: t('apiError.folderLayoutInvalid') });

    const badKind = await call('PUT', '/api/device-folders/layout', {
      folders,
      placements: [{ kind: 'folder', nodeId: 'n1', folderId: null, sortOrder: 0 }],
    });
    expect(badKind.status).toBe(400);

    const unknownFolder = await call('PUT', '/api/device-folders/layout', {
      folders,
      placements: [{ nodeId: 'n1', folderId: 'ghost', sortOrder: 0 }],
    });
    expect(unknownFolder.status).toBe(400);
    expect(unknownFolder.json).toEqual({ error: t('apiError.folderLayoutInvalid') });

    const dup = await call('PUT', '/api/device-folders/layout', {
      folders,
      placements: [
        { nodeId: 'n-dup', folderId: null, sortOrder: 0 },
        { nodeId: 'n-dup', folderId: null, sortOrder: 1 },
      ],
    });
    expect(dup.status).toBe(400);
    expect(dup.json).toEqual({ error: t('apiError.folderLayoutInvalid') });
  });

  test('旧客户端形态（kind:node + deviceId:null）仍被接受', async () => {
    const layout = await getLayout();
    const { status, json } = await call('PUT', '/api/device-folders/layout', {
      folders: folderOrder(layout),
      placements: [
        { kind: 'node', nodeId: 'legacy-node', deviceId: null, folderId: null, sortOrder: 0 },
      ],
    });
    expect(status).toBe(200);
    expect((json as unknown as DeviceFolderLayout).placements).toEqual([
      { nodeId: 'legacy-node', folderId: null, sortOrder: 0 },
    ]);
  });
});

describe('POST /api/device-folders/reset', () => {
  test('清空全部分组与 placement，并广播 device-folders', async () => {
    const id = await createFolder('reset-group');
    const layout = await getLayout();
    await call('PUT', '/api/device-folders/layout', {
      folders: folderOrder(layout),
      placements: [{ nodeId: 'reset-node', folderId: id, sortOrder: 0 }],
    });
    const received: SettingsNamespace[] = [];
    registerSettingsBroadcaster((namespace) => received.push(namespace));

    const { status, json } = await call('POST', '/api/device-folders/reset');
    expect(status).toBe(200);
    expect(json).toEqual({ folders: [], placements: [] });
    expect(received).toEqual(['device-folders']);
    expect(await getLayout()).toEqual({ folders: [], placements: [] });
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

  test('PUT /api/device-folders/layout 与 POST /reset 不被 :id 吃掉', async () => {
    const layout = await getLayout();
    const put = await handleApiRequest(
      new Request('http://localhost/api/device-folders/layout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folders: folderOrder(layout), placements: layout.placements }),
      }),
      {} as Server<unknown>
    );
    expect(put.status).toBe(200);
    const reset = await handleApiRequest(
      new Request('http://localhost/api/device-folders/reset', { method: 'POST' }),
      {} as Server<unknown>
    );
    expect(reset.status).toBe(200);
  });
});
