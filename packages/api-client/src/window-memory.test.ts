import { describe, expect, test } from 'bun:test';
import { WINDOW_MEMORY_SETTINGS_DEFAULTS } from '@vibeterm/shared';
import { ApiClient } from './client';
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
});

describe('putWindowMemorySettings', () => {
  test('整条 PUT 全量记录', async () => {
    const client = new StubApiClient([jsonResponse(record)]);
    await expect(putWindowMemorySettings(record, client)).resolves.toEqual(record);
    expect(client.calls[0]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(client.calls[0]?.init?.body))).toEqual(record);
  });
});
