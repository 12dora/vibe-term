import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { Device, SessionsMemoryResponse } from '@vibeterm/shared';
import type { Server } from 'bun';
import * as devicesDb from '../db/devices';
import { runMigrations } from '../db/migrate';
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
  test('无连接设备 supported:false windows:[]；有连接的用 tracker + 快照名', async () => {
    const list = spyOn(devicesDb, 'getAllDevices').mockReturnValue([
      device('dev-open', 'Open'),
      device('dev-closed', 'Closed'),
    ]);
    bindWindowMemoryRuntimeHost({
      requestTickAll() {},
      getRuntime(deviceId) {
        if (deviceId !== 'dev-open') return undefined;
        return {
          getWindowMemorySupported: () => true,
          getWindowMemory: () => [aggregate('@1', 'from-tracker')],
          getCurrentSnapshot: () => ({
            deviceId: 'dev-open',
            session: {
              id: '$1',
              name: 'main',
              windows: [
                {
                  id: '@1',
                  name: 'tmux-name',
                  customName: 'My window',
                  index: 0,
                  active: true,
                  panes: [],
                },
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
            ],
          },
          {
            deviceId: 'dev-closed',
            deviceName: 'Closed',
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
          getWindowMemorySupported: () => null,
          getWindowMemory: () => [aggregate('@3', 'fallback')],
          getCurrentSnapshot: () => ({
            deviceId: 'dev-a',
            session: {
              id: '$1',
              name: 'main',
              windows: [{ id: '@3', name: 'shell', index: 1, active: false, panes: [] }],
            },
          }),
        };
      },
    });
    try {
      const res = await handleApiRequest(req('GET', SESSIONS_MEMORY_PATH), fakeServer);
      const body = (await res.json()) as SessionsMemoryResponse;
      expect(body.devices[0]?.supported).toBe(false);
      expect(body.devices[0]?.windows[0]?.windowName).toBe('shell');
    } finally {
      list.mockRestore();
    }
  });
});
