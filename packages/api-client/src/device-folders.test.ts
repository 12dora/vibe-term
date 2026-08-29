import { describe, expect, test } from 'bun:test';
import { ApiClient } from './client';
import { resetDeviceFolderLayout } from './device-folders';

class StubApiClient extends ApiClient {
  calls: Array<{ path: string; init?: RequestInit }> = [];

  constructor(private responses: Response[]) {
    super('');
  }

  override fetch(path: string, init?: RequestInit): Promise<Response> {
    this.calls.push({ path, init });
    const next = this.responses.shift();
    if (!next) {
      return Promise.reject(new Error('unexpected request'));
    }
    return Promise.resolve(next);
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('resetDeviceFolderLayout', () => {
  test('POST /api/device-folders/reset，返回服务端的新布局', async () => {
    const client = new StubApiClient([jsonResponse({ folders: [], placements: [] })]);
    const result = await resetDeviceFolderLayout('fallback', client);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].path).toBe('/api/device-folders/reset');
    expect(client.calls[0].init?.method).toBe('POST');
    expect(result).toEqual({ folders: [], placements: [] });
  });

  test('非 2xx 解析 error 字段，缺失时用 fallback', async () => {
    const withError = new StubApiClient([jsonResponse({ error: 'boom' }, 500)]);
    await expect(resetDeviceFolderLayout('fallback', withError)).rejects.toThrow('boom');

    const withoutError = new StubApiClient([new Response('oops', { status: 500 })]);
    await expect(resetDeviceFolderLayout('fallback', withoutError)).rejects.toThrow('fallback');
  });
});
