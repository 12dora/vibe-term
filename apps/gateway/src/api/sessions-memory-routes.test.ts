import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { Device, SessionsMemoryResponse, TmuxPane, TmuxWindow } from '@vibeterm/shared';
import type { Server } from 'bun';
import * as devicesDb from '../db/devices';
import { runMigrations } from '../db/migrate';
import {
  getWindowOomMarkStore,
  resetWindowOomMarkStoreForTests,
} from '../window-memory/oom-mark-store';
import { bindWindowMemoryRuntimeHost } from '../window-memory/runtime-host';
import type { WindowMemoryAggregate } from '../window-memory/types';
import { handleApiRequest } from './index';
import { SESSIONS_MEMORY_PATH } from './sessions-memory-routes';

const fakeServer = {} as Server<unknown>;

beforeAll(() => {
  runMigrations();
});

afterEach(() => {
  bindWindowMemoryRuntimeHost(null);
  resetWindowOomMarkStoreForTests();
});

function req(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, { method });
}

function device(id: string, name: string): Device {
  return {
    id,
    name,
    type: 'local',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function pane(windowId: string, id: string, index: number): TmuxPane {
  return {
    id,
    windowId,
    index,
    active: index === 0,
    width: 80,
    height: 24,
  };
}

function snapshotWindow(
  id: string,
  name: string,
  opts: { customName?: string; paneCount?: number } = {}
): TmuxWindow {
  const paneCount = opts.paneCount ?? 1;
  return {
    id,
    name,
    customName: opts.customName,
    index: 0,
    active: true,
    panes: Array.from({ length: paneCount }, (_, index) => pane(id, `%${index}`, index)),
  };
}

function aggregate(windowId: string, windowName: string): WindowMemoryAggregate {
  return {
    windowId,
    windowName,
    panes: 2,
    scopes: ['tmux-spawn-aaa.scope', 'tmux-spawn-bbb.scope'],
    current: 4096,
    high: 8192,
    max: 12288,
    swapMax: 1024,
    oomKills: 1,
    oomFlag: true,
    sampledAt: 1_700_000_000_000,
  };
}

describe('GET /api/sessions/memory', () => {
  test('未挂上 runtime → connected:false supported:false windows:[]', async () => {
    const list = spyOn(devicesDb, 'getAllDevices').mockReturnValue([
      device('dev-closed', 'Closed'),
    ]);
    bindWindowMemoryRuntimeHost({
      requestTickAll() {},
      getRuntime() {
        return undefined;
      },
    });
    try {
      const res = await handleApiRequest(req('GET', SESSIONS_MEMORY_PATH), fakeServer);
      expect(res.status).toBe(200);
      const body = (await res.json()) as SessionsMemoryResponse;
      expect(body).toEqual({
        devices: [
          {
            deviceId: 'dev-closed',
            deviceName: 'Closed',
            connected: false,
            supported: false,
            windows: [],
          },
        ],
      });
    } finally {
      list.mockRestore();
    }
  });

  test('已挂上但连接未开 → connected:false', async () => {
    const list = spyOn(devicesDb, 'getAllDevices').mockReturnValue([device('dev-a', 'A')]);
    bindWindowMemoryRuntimeHost({
      requestTickAll() {},
      getRuntime() {
        return {
          isConnected: () => false,
          getWindowMemorySupported: () => true,
          getWindowMemory: () => [aggregate('@1', 'from-tracker')],
          getCurrentSnapshot: () => ({
            deviceId: 'dev-a',
            session: {
              id: '$1',
              name: 'main',
              windows: [snapshotWindow('@1', 'shell')],
            },
          }),
        };
      },
    });
    try {
      const res = await handleApiRequest(req('GET', SESSIONS_MEMORY_PATH), fakeServer);
      const body = (await res.json()) as SessionsMemoryResponse;
      expect(body.devices[0]).toEqual({
        deviceId: 'dev-a',
        deviceName: 'A',
        connected: false,
        supported: false,
        windows: [],
      });
    } finally {
      list.mockRestore();
    }
  });

  test('connected+unsupported 按快照列窗口，内存字段为 0，粘性 oomFlag 仍显示', async () => {
    const list = spyOn(devicesDb, 'getAllDevices').mockReturnValue([device('dev-open', 'Open')]);
    getWindowOomMarkStore().mark('dev-open', '@1', 'tmux-spawn-aaa.scope', 3);
    bindWindowMemoryRuntimeHost({
      requestTickAll() {},
      getRuntime() {
        return {
          isConnected: () => true,
          getWindowMemorySupported: () => false,
          getWindowMemory: () => [],
          getCurrentSnapshot: () => ({
            deviceId: 'dev-open',
            session: {
              id: '$1',
              name: 'main',
              windows: [
                snapshotWindow('@1', 'tmux-name', { customName: 'My window', paneCount: 2 }),
                snapshotWindow('@2', 'shell'),
              ],
            },
          }),
        };
      },
    });
    try {
      const res = await handleApiRequest(req('GET', SESSIONS_MEMORY_PATH), fakeServer);
      const body = (await res.json()) as SessionsMemoryResponse;
      expect(body.devices[0]).toEqual({
        deviceId: 'dev-open',
        deviceName: 'Open',
        connected: true,
        supported: false,
        windows: [
          {
            windowId: '@1',
            windowName: 'My window',
            panes: 2,
            scopes: [],
            current: 0,
            high: 0,
            max: 0,
            swapMax: 0,
            oomKills: 0,
            oomFlag: true,
            sampledAt: 0,
          },
          {
            windowId: '@2',
            windowName: 'shell',
            panes: 1,
            scopes: [],
            current: 0,
            high: 0,
            max: 0,
            swapMax: 0,
            oomKills: 0,
            oomFlag: false,
            sampledAt: 0,
          },
        ],
      });
    } finally {
      list.mockRestore();
    }
  });

  test('connected+supported 按快照列窗口并按 windowId 合并 tracker 聚合', async () => {
    const list = spyOn(devicesDb, 'getAllDevices').mockReturnValue([
      device('dev-open', 'Open'),
      device('dev-closed', 'Closed'),
    ]);
    getWindowOomMarkStore().mark('dev-open', '@2', 'tmux-spawn-zzz.scope', 1);
    bindWindowMemoryRuntimeHost({
      requestTickAll() {},
      getRuntime(deviceId) {
        if (deviceId !== 'dev-open') return undefined;
        return {
          isConnected: () => true,
          getWindowMemorySupported: () => true,
          getWindowMemory: () => [aggregate('@1', 'from-tracker')],
          getCurrentSnapshot: () => ({
            deviceId: 'dev-open',
            session: {
              id: '$1',
              name: 'main',
              windows: [
                snapshotWindow('@1', 'tmux-name', { customName: 'My window', paneCount: 2 }),
                snapshotWindow('@2', 'other', { paneCount: 3 }),
              ],
            },
          }),
        };
      },
    });
    try {
      const res = await handleApiRequest(req('GET', SESSIONS_MEMORY_PATH), fakeServer);
      expect(res.status).toBe(200);
      const body = (await res.json()) as SessionsMemoryResponse;
      expect(body).toEqual({
        devices: [
          {
            deviceId: 'dev-open',
            deviceName: 'Open',
            connected: true,
            supported: true,
            windows: [
              {
                windowId: '@1',
                windowName: 'My window',
                panes: 2,
                scopes: ['tmux-spawn-aaa.scope', 'tmux-spawn-bbb.scope'],
                current: 4096,
                high: 8192,
                max: 12288,
                swapMax: 1024,
                oomKills: 1,
                oomFlag: true,
                sampledAt: 1_700_000_000_000,
              },
              {
                windowId: '@2',
                windowName: 'other',
                panes: 3,
                scopes: [],
                current: 0,
                high: 0,
                max: 0,
                swapMax: 0,
                oomKills: 0,
                oomFlag: true,
                sampledAt: 0,
              },
            ],
          },
          {
            deviceId: 'dev-closed',
            deviceName: 'Closed',
            connected: false,
            supported: false,
            windows: [],
          },
        ],
      });
    } finally {
      list.mockRestore();
    }
  });

  test('supported 为 null 时按 false；无 customName 用 name', async () => {
    const list = spyOn(devicesDb, 'getAllDevices').mockReturnValue([device('dev-a', 'A')]);
    bindWindowMemoryRuntimeHost({
      requestTickAll() {},
      getRuntime() {
        return {
          isConnected: () => true,
          getWindowMemorySupported: () => null,
          getWindowMemory: () => [aggregate('@3', 'fallback')],
          getCurrentSnapshot: () => ({
            deviceId: 'dev-a',
            session: {
              id: '$1',
              name: 'main',
              windows: [snapshotWindow('@3', 'shell')],
            },
          }),
        };
      },
    });
    try {
      const res = await handleApiRequest(req('GET', SESSIONS_MEMORY_PATH), fakeServer);
      const body = (await res.json()) as SessionsMemoryResponse;
      expect(body.devices[0]?.connected).toBe(true);
      expect(body.devices[0]?.supported).toBe(false);
      expect(body.devices[0]?.windows[0]?.windowName).toBe('shell');
      expect(body.devices[0]?.windows[0]?.current).toBe(4096);
    } finally {
      list.mockRestore();
    }
  });
});
