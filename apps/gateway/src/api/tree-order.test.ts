import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import {
  createDevice,
  ensureSiteSettingsInitialized,
  getDeviceTreeOrder,
  setPaneOrder,
  setWindowOrder,
} from '../db';
import { runMigrations } from '../db/migrate';
import {
  type SettingsNamespace,
  type TreeOverlayBridge,
  registerSettingsBroadcaster,
  registerTreeOverlayBridge,
} from '../settings/broadcaster';
import { handleApiRequest } from './index';
import { dispatchRoutes } from './route';
import { treeOrderRoutes } from './tree-order';

const DEVICE_ID = 'tree-order-test-device';

beforeAll(() => {
  runMigrations();
  ensureSiteSettingsInitialized();
  const now = new Date().toISOString();
  createDevice({
    id: DEVICE_ID,
    name: 'tree-order-test',
    type: 'local',
    authMode: 'auto',
    session: 'test-session',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });
});

afterEach(() => {
  registerTreeOverlayBridge(null);
  registerSettingsBroadcaster(null);
});

function createFakeBridge() {
  const calls: string[] = [];
  const bridge: TreeOverlayBridge = {
    reorderWindows: (deviceId, windowIds) => {
      calls.push(`reorderWindows:${deviceId}`);
      setWindowOrder(deviceId, windowIds);
    },
    reorderPanes: (deviceId, windowId, paneIds) => {
      calls.push(`reorderPanes:${deviceId}:${windowId}`);
      setPaneOrder(deviceId, windowId, paneIds);
    },
    renameWindow: (deviceId, windowId, name) => {
      calls.push(`renameWindow:${deviceId}:${windowId}:${name}`);
    },
    renamePane: (deviceId, paneId, name) => {
      calls.push(`renamePane:${deviceId}:${paneId}:${name}`);
    },
    getCustomNames: () => ({ windows: { '@1': 'build' }, panes: { '%2': 'logs' } }),
  };
  return { bridge, calls };
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
  const response = dispatchRoutes(req, pathname, treeOrderRoutes, {
    server: {} as never,
    path: pathname,
  });
  if (!response) {
    throw new Error(`no route matched: ${method} ${path}`);
  }
  const resolved = await response;
  return { status: resolved.status, json: (await resolved.json()) as Record<string, unknown> };
}

describe('GET /api/devices/:id/tree-order', () => {
  test('未知设备返回 404', async () => {
    const { status } = await call('GET', '/api/devices/no-such-device/tree-order');
    expect(status).toBe(404);
  });

  test('返回排序与自定义名 overlay', async () => {
    const { bridge } = createFakeBridge();
    registerTreeOverlayBridge(bridge);
    setWindowOrder(DEVICE_ID, ['@2', '@1']);
    setPaneOrder(DEVICE_ID, '@1', ['%2', '%1']);

    const { status, json } = await call('GET', `/api/devices/${DEVICE_ID}/tree-order`);
    expect(status).toBe(200);
    expect(json.deviceId).toBe(DEVICE_ID);
    expect(json.windows).toEqual(['@2', '@1']);
    expect(json.panes).toEqual({ '@1': ['%2', '%1'] });
    expect(json.windowNames).toEqual({ '@1': 'build' });
    expect(json.paneNames).toEqual({ '%2': 'logs' });
  });

  test('桥未注册时自定义名为空对象', async () => {
    const { status, json } = await call('GET', `/api/devices/${DEVICE_ID}/tree-order`);
    expect(status).toBe(200);
    expect(json.windowNames).toEqual({});
    expect(json.paneNames).toEqual({});
  });
});

describe('PUT /api/devices/:id/tree-order', () => {
  test('经桥写入 windows 与 panes 排序', async () => {
    const { bridge, calls } = createFakeBridge();
    registerTreeOverlayBridge(bridge);

    const { status, json } = await call('PUT', `/api/devices/${DEVICE_ID}/tree-order`, {
      windows: ['@3', '@1'],
      panes: { '@3': ['%9', '%8'] },
    });
    expect(status).toBe(200);
    expect(calls).toContain(`reorderWindows:${DEVICE_ID}`);
    expect(calls).toContain(`reorderPanes:${DEVICE_ID}:@3`);
    expect(json.windows).toEqual(['@3', '@1']);
    expect((json.panes as Record<string, string[]>)['@3']).toEqual(['%9', '%8']);
    expect(getDeviceTreeOrder(DEVICE_ID).windows).toEqual(['@3', '@1']);
  });

  test('未知设备返回 404', async () => {
    const { status } = await call('PUT', '/api/devices/no-such-device/tree-order', {
      windows: [],
    });
    expect(status).toBe(404);
  });

  test('非法 body 返回 400', async () => {
    registerTreeOverlayBridge(createFakeBridge().bridge);
    expect((await call('PUT', `/api/devices/${DEVICE_ID}/tree-order`, {})).status).toBe(400);
    expect(
      (await call('PUT', `/api/devices/${DEVICE_ID}/tree-order`, { windows: [1, 2] })).status
    ).toBe(400);
    expect(
      (await call('PUT', `/api/devices/${DEVICE_ID}/tree-order`, { panes: { '@1': 'x' } })).status
    ).toBe(400);
    expect(
      (await call('PUT', `/api/devices/${DEVICE_ID}/tree-order`, { windows: { '@1': [] } })).status
    ).toBe(400);
    expect(
      (await call('PUT', `/api/devices/${DEVICE_ID}/tree-order`, { panes: ['%1'] })).status
    ).toBe(400);
    expect(
      (await call('PUT', `/api/devices/${DEVICE_ID}/tree-order`, { extra: true })).status
    ).toBe(400);
  });

  test('仅 panes 时写入 pane 排序且不碰 windows', async () => {
    const { bridge, calls } = createFakeBridge();
    registerTreeOverlayBridge(bridge);
    setWindowOrder(DEVICE_ID, ['@keep']);

    const { status, json } = await call('PUT', `/api/devices/${DEVICE_ID}/tree-order`, {
      panes: { '@keep': ['%2', '%1'] },
    });
    expect(status).toBe(200);
    expect(calls).not.toContain(`reorderWindows:${DEVICE_ID}`);
    expect(calls).toContain(`reorderPanes:${DEVICE_ID}:@keep`);
    expect(json.windows).toEqual(['@keep']);
    expect((json.panes as Record<string, string[]>)['@keep']).toEqual(['%2', '%1']);
  });

  test('桥未注册返回 503', async () => {
    const { status } = await call('PUT', `/api/devices/${DEVICE_ID}/tree-order`, {
      windows: ['@1'],
    });
    expect(status).toBe(503);
  });
});

describe('PATCH window/pane 自定义名', () => {
  test('window 名经桥写入（含 URL 编码 id）', async () => {
    const { bridge, calls } = createFakeBridge();
    registerTreeOverlayBridge(bridge);

    const { status, json } = await call('PATCH', `/api/devices/${DEVICE_ID}/windows/%401/name`, {
      name: '  build  ',
    });
    expect(status).toBe(200);
    expect(calls).toContain(`renameWindow:${DEVICE_ID}:@1:  build  `);
    expect(json.name).toBe('build');
  });

  test('pane 名经桥写入，空串表示清除', async () => {
    const { bridge, calls } = createFakeBridge();
    registerTreeOverlayBridge(bridge);

    const { status } = await call('PATCH', `/api/devices/${DEVICE_ID}/panes/%252/name`, {
      name: '',
    });
    expect(status).toBe(200);
    expect(calls).toContain(`renamePane:${DEVICE_ID}:%2:`);
  });

  test('非法 pane id 返回 400', async () => {
    registerTreeOverlayBridge(createFakeBridge().bridge);
    const { status } = await call('PATCH', `/api/devices/${DEVICE_ID}/panes/abc/name`, {
      name: 'x',
    });
    expect(status).toBe(400);
  });

  test('body 缺 name 返回 400', async () => {
    registerTreeOverlayBridge(createFakeBridge().bridge);
    const { status } = await call('PATCH', `/api/devices/${DEVICE_ID}/windows/%401/name`, {});
    expect(status).toBe(400);
  });

  test('桥未注册返回 503', async () => {
    const { status } = await call('PATCH', `/api/devices/${DEVICE_ID}/windows/%401/name`, {
      name: 'x',
    });
    expect(status).toBe(503);
  });
});

describe('设置写路径联动广播', () => {
  test('PATCH /api/settings/site 触发 site 命名空间广播', async () => {
    const received: SettingsNamespace[] = [];
    registerSettingsBroadcaster((namespace) => {
      received.push(namespace);
    });

    const req = new Request('http://localhost/api/settings/site', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'tmex-test' }),
    });
    const response = await handleApiRequest(req, {} as Server<unknown>);
    expect(response.status).toBe(200);
    expect(received).toEqual(['site']);
  });

  test('PUT tree-order 经桥间接触发广播（桥由 wsServer 实现负责）', async () => {
    const received: SettingsNamespace[] = [];
    registerSettingsBroadcaster((namespace) => {
      received.push(namespace);
    });
    const { bridge } = createFakeBridge();
    registerTreeOverlayBridge({
      ...bridge,
      reorderWindows: (deviceId, windowIds) => {
        setWindowOrder(deviceId, windowIds);
        received.push('tree-order');
      },
    });

    const { status } = await call('PUT', `/api/devices/${DEVICE_ID}/tree-order`, {
      windows: ['@1'],
    });
    expect(status).toBe(200);
    expect(received).toEqual(['tree-order']);
  });
});
