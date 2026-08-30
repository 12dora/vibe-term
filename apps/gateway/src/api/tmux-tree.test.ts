import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import type { Server } from 'bun';
import { createDevice, ensureSiteSettingsInitialized, setPaneOrder, setWindowOrder } from '../db';
import { getSqliteClient } from '../db/client';
import * as devicesDb from '../db/devices';
import { runMigrations } from '../db/migrate';
import { type TreeOverlayBridge, registerTreeOverlayBridge } from '../settings/broadcaster';
import { registerSnapshotLookup } from '../tmux/snapshot-directory';
import { handleApiRequest } from './index';
import { handleTmuxTreeApiRequest } from './tmux-tree';

const DEVICE_A = 'tmux-tree-test-device-a';
const DEVICE_B = 'tmux-tree-test-device-b';

beforeAll(() => {
  runMigrations();
  ensureSiteSettingsInitialized();
  const now = new Date().toISOString();
  createDevice({
    id: DEVICE_A,
    name: 'tree-a',
    type: 'local',
    authMode: 'auto',
    session: 'test-session-a',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });
  createDevice({
    id: DEVICE_B,
    name: 'tree-b',
    type: 'local',
    authMode: 'auto',
    session: 'test-session-b',
    sortOrder: 1,
    createdAt: now,
    updatedAt: now,
  });
});

afterEach(() => {
  registerSnapshotLookup(null);
  registerTreeOverlayBridge(null);
});

function makeSnapshot(deviceId: string): StateSnapshotPayload {
  return {
    deviceId,
    session: {
      id: '$1',
      name: 'test-session',
      windows: [
        {
          id: '@1',
          name: 'win-one',
          index: 0,
          active: true,
          panes: [
            { id: '%1', windowId: '@1', index: 0, active: true, width: 80, height: 24 },
            { id: '%2', windowId: '@1', index: 1, active: false, width: 80, height: 24 },
          ],
        },
        {
          id: '@2',
          name: 'win-two',
          index: 1,
          active: false,
          panes: [{ id: '%3', windowId: '@2', index: 0, active: false, width: 80, height: 24 }],
        },
      ],
    },
  };
}

function registerFakeNames(names: {
  windows: Record<string, string>;
  panes: Record<string, string>;
}) {
  const bridge: TreeOverlayBridge = {
    reorderWindows: () => {},
    reorderPanes: () => {},
    renameWindow: () => {},
    renamePane: () => {},
    getCustomNames: () => names,
  };
  registerTreeOverlayBridge(bridge);
}

async function call(
  method: string,
  path: string
): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request(`http://localhost${path}`, { method });
  const response = handleTmuxTreeApiRequest(req, new URL(req.url).pathname);
  if (!response) {
    throw new Error(`no route matched: ${method} ${path}`);
  }
  const resolved = await response;
  return { status: resolved.status, json: (await resolved.json()) as Record<string, unknown> };
}

interface TreeDeviceJson {
  deviceId: string;
  deviceName: string;
  session: {
    windows: Array<{
      id: string;
      customName?: string;
      panes: Array<{ id: string; customName?: string }>;
    }>;
  } | null;
}

describe('GET /api/tmux/tree', () => {
  test('returns all devices with null session when no snapshot exists', async () => {
    const { status, json } = await call('GET', '/api/tmux/tree');
    expect(status).toBe(200);
    // 同进程其他测试文件共享 :memory: 库，只断言本文件造的设备，不断言全集
    const devices = json.devices as TreeDeviceJson[];
    const deviceA = devices.find((d) => d.deviceId === DEVICE_A);
    const deviceB = devices.find((d) => d.deviceId === DEVICE_B);
    expect(deviceA?.deviceName).toBe('tree-a');
    expect(deviceB?.deviceName).toBe('tree-b');
    expect(deviceA?.session).toBeNull();
    expect(deviceB?.session).toBeNull();
  });

  test('returns snapshot tree for devices that have one', async () => {
    registerSnapshotLookup((deviceId) => (deviceId === DEVICE_A ? makeSnapshot(deviceId) : null));

    const { status, json } = await call('GET', '/api/tmux/tree');
    expect(status).toBe(200);
    const devices = json.devices as TreeDeviceJson[];
    const deviceA = devices.find((d) => d.deviceId === DEVICE_A);
    const deviceB = devices.find((d) => d.deviceId === DEVICE_B);
    expect(deviceA?.session?.windows.map((w) => w.id)).toEqual(['@1', '@2']);
    expect(deviceA?.session?.windows[0]?.panes.map((p) => p.id)).toEqual(['%1', '%2']);
    expect(deviceB?.session).toBeNull();
  });

  test('applies tree-order overlay same as ws snapshot path', async () => {
    registerSnapshotLookup((deviceId) => (deviceId === DEVICE_A ? makeSnapshot(deviceId) : null));
    setWindowOrder(DEVICE_A, ['@2', '@1']);
    setPaneOrder(DEVICE_A, '@1', ['%2', '%1']);

    const { json } = await call('GET', `/api/tmux/tree?deviceId=${DEVICE_A}`);
    const [device] = json.devices as TreeDeviceJson[];
    expect(device.session?.windows.map((w) => w.id)).toEqual(['@2', '@1']);
    const windowOne = device.session?.windows.find((w) => w.id === '@1');
    expect(windowOne?.panes.map((p) => p.id)).toEqual(['%2', '%1']);

    setWindowOrder(DEVICE_A, []);
    setPaneOrder(DEVICE_A, '@1', []);
  });

  test('applies custom window/pane names overlay', async () => {
    registerSnapshotLookup((deviceId) => (deviceId === DEVICE_A ? makeSnapshot(deviceId) : null));
    registerFakeNames({ windows: { '@1': 'build' }, panes: { '%2': 'logs' } });

    const { json } = await call('GET', `/api/tmux/tree?deviceId=${DEVICE_A}`);
    const [device] = json.devices as TreeDeviceJson[];
    const windowOne = device.session?.windows.find((w) => w.id === '@1');
    expect(windowOne?.customName).toBe('build');
    expect(windowOne?.panes.find((p) => p.id === '%2')?.customName).toBe('logs');
    expect(windowOne?.panes.find((p) => p.id === '%1')?.customName).toBeUndefined();
  });

  test('filters by deviceId and 404s on unknown device', async () => {
    const ok = await call('GET', `/api/tmux/tree?deviceId=${DEVICE_B}`);
    expect(ok.status).toBe(200);
    expect((ok.json.devices as TreeDeviceJson[]).map((d) => d.deviceId)).toEqual([DEVICE_B]);

    const missing = await call('GET', '/api/tmux/tree?deviceId=no-such-device');
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBeDefined();
  });

  test('ignores non-GET methods', () => {
    const req = new Request('http://localhost/api/tmux/tree', { method: 'POST' });
    expect(handleTmuxTreeApiRequest(req, '/api/tmux/tree')).toBeNull();
  });

  test('is mounted in handleApiRequest routing', async () => {
    registerSnapshotLookup((deviceId) => (deviceId === DEVICE_A ? makeSnapshot(deviceId) : null));

    const req = new Request('http://localhost/api/tmux/tree', { method: 'GET' });
    const response = await handleApiRequest(req, {} as Server<unknown>);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { devices: TreeDeviceJson[] };
    expect(body.devices.find((d) => d.deviceId === DEVICE_A)?.session).not.toBeNull();
  });

  test('100 台设备树查询 ≤ 3 次 SQL，缺 tree-order 行用空默认值', async () => {
    const prefix = 'r3-tree-q-';
    const now = new Date().toISOString();
    for (let i = 0; i < 100; i++) {
      createDevice({
        id: `${prefix}${String(i).padStart(3, '0')}`,
        name: `tree-q-${i}`,
        type: 'local',
        authMode: 'auto',
        session: 'tmex',
        sortOrder: 1000 + i,
        createdAt: now,
        updatedAt: now,
      });
    }
    setWindowOrder(`${prefix}000`, ['@9']);

    const orderSpy = spyOn(devicesDb, 'getDeviceTreeOrder');
    const db = getSqliteClient();
    const orig = db.prepare.bind(db);
    const sqls: string[] = [];
    db.prepare = ((sql: string) => {
      sqls.push(sql);
      return orig(sql);
    }) as typeof db.prepare;
    try {
      const { status, json } = await call('GET', '/api/tmux/tree');
      expect(status).toBe(200);
      expect(sqls.filter((sql) => /^\s*select\b/i.test(sql)).length).toBeLessThanOrEqual(3);
      expect(orderSpy).toHaveBeenCalledTimes(0);
      const devices = json.devices as TreeDeviceJson[];
      const ordered = devices.find((d) => d.deviceId === `${prefix}000`);
      const empty = devices.find((d) => d.deviceId === `${prefix}001`);
      expect(ordered?.deviceName).toBe('tree-q-0');
      expect(empty?.deviceName).toBe('tree-q-1');
      expect(empty?.session).toBeNull();
    } finally {
      orderSpy.mockRestore();
      db.prepare = orig;
    }
  });
});
