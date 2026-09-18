import { describe, expect, test } from 'bun:test';
import { WINDOW_MEMORY_SETTINGS_DEFAULTS } from '@vibeterm/shared';
import { ApiClient, ApiError } from './client';
import { getWindowMemorySettings, putWindowMemorySettings } from './window-memory';

class StubApiClient extends ApiClient {
  calls: Array<{ path: string; init?: RequestInit }> = [];

  constructor(private responses: Response[]) {
    super('');
  }

  override fetch(path: string, init?: RequestInit): Promise<Response> {
    this.calls.push({ path, init });
    const next = this.responses.shift();
    if (!next) return Promise.reject(new Error('unexpected request'));
    return Promise.resolve(next);
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const record = {
  enabled: false,
  memoryHighMb: 4096,
  memoryMaxMb: 6144,
  memorySwapMaxMb: 0,
  sampleIntervalSec: 10,
};

describe('getWindowMemorySettings', () => {
  test('读裸记录', async () => {
    const client = new StubApiClient([jsonResponse(record)]);
    await expect(getWindowMemorySettings(client)).resolves.toEqual(record);
    expect(client.calls[0]?.path).toBe('/api/settings/window-memory');
    expect(client.calls[0]?.init).toBeUndefined();
  });

  test('信封形态也认，缺字段回落到契约默认值', async () => {
    const client = new StubApiClient([jsonResponse({ settings: { memoryHighMb: 2048 } })]);
    await expect(getWindowMemorySettings(client)).resolves.toEqual({
      ...WINDOW_MEMORY_SETTINGS_DEFAULTS,
      memoryHighMb: 2048,
    });
  });

  test('非 2xx 抛错', async () => {
    const client = new StubApiClient([jsonResponse({ error: 'nope' }, 500)]);
    await expect(getWindowMemorySettings(client)).rejects.toThrow();
  });

  test('转发器的顶层信封保留 code / status，不折成兜底文案', async () => {
    const client = new StubApiClient([
      jsonResponse({ code: 'NODE_UNREACHABLE', nodeId: 'n1', reason: 'no link' }, 503),
    ]);
    const err = (await getWindowMemorySettings(client).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('NODE_UNREACHABLE');
    expect(err.status).toBe(503);
    expect(err.nodeId).toBe('n1');
    expect(err.reason).toBe('no link');
  });

  test('未登录与老节点的 404 各自可辨', async () => {
    const login = new StubApiClient([jsonResponse({ code: 'NODE_LOGIN_REQUIRED' }, 401)]);
    const loginErr = (await getWindowMemorySettings(login).catch((e) => e)) as ApiError;
    expect(loginErr.code).toBe('NODE_LOGIN_REQUIRED');

    const old = new StubApiClient([jsonResponse({ error: 'not found' }, 404)]);
    const oldErr = (await getWindowMemorySettings(old).catch((e) => e)) as ApiError;
    expect(oldErr.status).toBe(404);
    expect(oldErr.code).toBeNull();
  });
});

describe('putWindowMemorySettings', () => {
  test('整条 PUT 全量记录', async () => {
    const client = new StubApiClient([jsonResponse(record)]);
    await expect(putWindowMemorySettings(record, client)).resolves.toEqual(record);
    expect(client.calls[0]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(client.calls[0]?.init?.body))).toEqual(record);
  });

  test('网关校验失败带回人话与错误码', async () => {
    const client = new StubApiClient([
      jsonResponse(
        {
          code: 'INVALID_WINDOW_MEMORY_SETTINGS',
          error: { code: 'INVALID_WINDOW_MEMORY_SETTINGS', message: 'memoryHighMb must be > 0' },
        },
        400
      ),
    ]);
    const err = (await putWindowMemorySettings(record, client).catch((e) => e)) as ApiError;
    expect(err.status).toBe(400);
    expect(err.code).toBe('INVALID_WINDOW_MEMORY_SETTINGS');
    expect(err.message).toBe('memoryHighMb must be > 0');
  });
});
