import { describe, expect, test } from 'bun:test';
import { ApiClient } from './client';
import {
  SESSIONS_MEMORY_PATH,
  devicesWithoutMemoryLimits,
  getSessionsMemory,
} from './sessions-memory';

function client(body: unknown, status = 200): ApiClient {
  return new ApiClient('', () => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

const WINDOW = {
  windowId: '@1',
  windowName: 'main',
  scopes: ['tmux-spawn-1.scope'],
  current: 1024,
  high: 2048,
  max: 4096,
  swapMax: 0,
  oomKills: 1,
  oomFlag: true,
  panes: 2,
  sampledAt: 17,
  source: 'rss',
};

describe('getSessionsMemory', () => {
  test('GET /api/sessions/memory 并按契约归一化', async () => {
    const response = await getSessionsMemory(
      client({
        devices: [
          {
            deviceId: 'dev-1',
            deviceName: '本机',
            connected: true,
            supported: true,
            limitsSupported: false,
            windows: [WINDOW],
          },
        ],
      })
    );
    expect(response.devices).toEqual([
      {
        deviceId: 'dev-1',
        deviceName: '本机',
        connected: true,
        supported: true,
        limitsSupported: false,
        windows: [{ ...WINDOW, source: 'rss' }],
      },
    ]);
  });

  test('stale 只在网关明确标记时透传', async () => {
    const response = await getSessionsMemory(
      client({
        devices: [
          {
            deviceId: 'dev-1',
            deviceName: '本机',
            connected: true,
            supported: true,
            limitsSupported: true,
            windows: [
              { ...WINDOW, stale: true },
              { ...WINDOW, windowId: '@2', stale: 'yes' },
            ],
          },
        ],
      })
    );
    expect(response.devices[0]?.windows[0]?.stale).toBe(true);
    expect('stale' in (response.devices[0]?.windows[1] ?? {})).toBe(false);
  });

  test('sampledAgeMs 只透传非负有限数', async () => {
    const response = await getSessionsMemory(
      client({
        devices: [
          {
            deviceId: 'dev-1',
            deviceName: '本机',
            connected: true,
            supported: true,
            limitsSupported: true,
            windows: [
              { ...WINDOW, sampledAgeMs: 1500 },
              { ...WINDOW, windowId: '@2', sampledAgeMs: -1 },
              { ...WINDOW, windowId: '@3', sampledAgeMs: '12' },
            ],
          },
        ],
      })
    );
    const windows = response.devices[0]?.windows ?? [];
    expect(windows[0]?.sampledAgeMs).toBe(1500);
    expect(windows[0]?.high).toBe(2048);
    expect('sampledAgeMs' in (windows[1] ?? {})).toBe(false);
    expect('sampledAgeMs' in (windows[2] ?? {})).toBe(false);
  });

  test('路径固定', async () => {
    let seen = '';
    const recorder = new ApiClient('', (url) => {
      seen = url;
      return Promise.resolve(new Response('{"devices":[]}', { status: 200 }));
    });
    await getSessionsMemory(recorder);
    expect(seen).toBe(SESSIONS_MEMORY_PATH);
  });

  test('老网关缺 limitsSupported / source：判定为 null 与 cgroup', async () => {
    const response = await getSessionsMemory(
      client({
        devices: [
          {
            deviceId: 'dev-1',
            deviceName: 'old',
            connected: true,
            supported: true,
            windows: [{ windowId: '@1', windowName: 'main', current: 5 }],
          },
        ],
      })
    );
    const device = response.devices[0];
    expect(device?.limitsSupported).toBeNull();
    expect(device?.windows[0]?.source).toBe('cgroup');
    expect(device?.windows[0]?.high).toBe(0);
    expect(device?.windows[0]?.scopes).toEqual([]);
  });

  test('devices 不是数组时返回空表而不是抛错', async () => {
    expect(await getSessionsMemory(client({ devices: null }))).toEqual({ devices: [] });
  });

  test('非 2xx 抛错', async () => {
    await expect(getSessionsMemory(client({}, 500))).rejects.toThrow();
  });
});

describe('devicesWithoutMemoryLimits', () => {
  const device = (patch: Record<string, unknown>) => ({
    deviceId: 'd',
    deviceName: 'd',
    connected: true,
    supported: true,
    limitsSupported: false,
    windows: [],
    ...patch,
  });

  test('只挑「已连接 + 明确不支持限额」的设备', () => {
    const response = {
      devices: [
        device({ deviceId: 'a', deviceName: 'A' }),
        device({ deviceId: 'b', deviceName: 'B', limitsSupported: true }),
        device({ deviceId: 'c', deviceName: 'C', limitsSupported: null }),
        device({ deviceId: 'd', deviceName: 'D', connected: false }),
      ],
    };
    expect(devicesWithoutMemoryLimits(response).map((row) => row.deviceName)).toEqual(['A']);
  });
});
