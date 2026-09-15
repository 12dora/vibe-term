import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { WINDOW_MEMORY_SETTINGS_DEFAULTS, type WindowMemorySettings } from '@vibeterm/shared';
import { eq } from 'drizzle-orm';
import { handleApiRequest } from '../api/index';
import { dispatchRoutes } from '../api/route';
import { getDb as getOrmDb } from '../db/client';
import { getGatewayKv } from '../db/kv';
import { runMigrations } from '../db/migrate';
import { gatewayKv } from '../db/schema';
import { bindWindowMemoryRuntimeHost } from '../window-memory/runtime-host';
import {
  WINDOW_MEMORY_SETTINGS_KV_KEY,
  getWindowMemorySettingsStore,
  resetWindowMemorySettingsStoreForTests,
} from '../window-memory/settings-store';
import {
  INVALID_WINDOW_MEMORY_SETTINGS,
  WINDOW_MEMORY_SETTINGS_PATH,
  windowMemorySettingsRoutes,
} from './window-memory-route';

beforeAll(() => {
  runMigrations();
});

afterEach(() => {
  resetWindowMemorySettingsStoreForTests();
  bindWindowMemoryRuntimeHost(null);
  getOrmDb().delete(gatewayKv).where(eq(gatewayKv.key, WINDOW_MEMORY_SETTINGS_KV_KEY)).run();
});

async function call(method: 'GET' | 'PUT', body?: unknown): Promise<Response> {
  const req = new Request(`http://localhost${WINDOW_MEMORY_SETTINGS_PATH}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const res = dispatchRoutes(req, WINDOW_MEMORY_SETTINGS_PATH, windowMemorySettingsRoutes, {
    path: WINDOW_MEMORY_SETTINGS_PATH,
  });
  if (!res) throw new Error('route not matched');
  return res;
}

const full: WindowMemorySettings = {
  enabled: false,
  memoryHighMb: 1024,
  memoryMaxMb: 2048,
  memorySwapMaxMb: 256,
  sampleIntervalSec: 10,
};

describe('/api/settings/window-memory', () => {
  test('GET 缺省回默认记录', async () => {
    const res = await call('GET');
    expect(res.status).toBe(200);
    expect((await res.json()) as WindowMemorySettings).toEqual(WINDOW_MEMORY_SETTINGS_DEFAULTS);
  });

  test('PUT 落库并回读，成功后 requestTickAll', async () => {
    const ticks: number[] = [];
    bindWindowMemoryRuntimeHost({
      requestTickAll() {
        ticks.push(1);
      },
      getRuntime() {
        return undefined;
      },
    });
    const put = await call('PUT', full);
    expect(put.status).toBe(200);
    expect((await put.json()) as WindowMemorySettings).toEqual(full);
    expect(JSON.parse(getGatewayKv(WINDOW_MEMORY_SETTINGS_KV_KEY) ?? '')).toEqual(full);
    expect(ticks).toEqual([1]);
    expect(getWindowMemorySettingsStore().get()).toEqual(full);

    resetWindowMemorySettingsStoreForTests();
    const get = await call('GET');
    expect((await get.json()) as WindowMemorySettings).toEqual(full);
  });

  test('非法 body 回 400 INVALID_WINDOW_MEMORY_SETTINGS 且不落库、不 tick', async () => {
    const ticks: number[] = [];
    bindWindowMemoryRuntimeHost({
      requestTickAll() {
        ticks.push(1);
      },
      getRuntime() {
        return undefined;
      },
    });
    const res = await call('PUT', { ...full, memoryHighMb: 5000, memoryMaxMb: 100 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: { code: string; message: string } };
    expect(body.code).toBe(INVALID_WINDOW_MEMORY_SETTINGS);
    expect(body.error.code).toBe(INVALID_WINDOW_MEMORY_SETTINGS);
    expect(body.error.message).toContain('memoryHighMb');
    expect(getGatewayKv(WINDOW_MEMORY_SETTINGS_KV_KEY)).toBeNull();
    expect(ticks).toEqual([]);
  });

  test('缺 body 回 400', async () => {
    const res = await call('PUT');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe(INVALID_WINDOW_MEMORY_SETTINGS);
  });

  test('挂在生产路由表上', async () => {
    const res = await handleApiRequest(
      new Request(`http://localhost${WINDOW_MEMORY_SETTINGS_PATH}`)
    );
    expect(res.status).toBe(200);
  });
});
