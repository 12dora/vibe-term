import { describe, expect, test } from 'bun:test';
import { ApiClient } from './client';
import { FileApiError } from './file-errors';
import { reorderFileRoots } from './file-resources';

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

describe('reorderFileRoots', () => {
  test('PUT /api/files/roots/order，请求体为 { rootIds }，原样返回 { roots }', async () => {
    const payload = {
      roots: [
        { id: 'r-b', sortOrder: 0 },
        { id: 'r-a', sortOrder: 1 },
      ],
    };
    const client = new StubApiClient([jsonResponse(payload)]);

    const result = await reorderFileRoots(['r-b', 'r-a'], client);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].path).toBe('/api/files/roots/order');
    expect(client.calls[0].init?.method).toBe('PUT');
    expect(client.calls[0].init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(client.calls[0].init?.body).toBe(JSON.stringify({ rootIds: ['r-b', 'r-a'] }));
    expect(result.roots.map((root) => root.id)).toEqual(['r-b', 'r-a']);
  });

  test('非 2xx 抛 FileApiError，带响应体的 error 文案与状态码', async () => {
    const client = new StubApiClient([jsonResponse({ error: 'invalid request' }, 400)]);

    const error = await reorderFileRoots(['r-a'], client).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FileApiError);
    expect((error as FileApiError).message).toBe('invalid request');
    expect((error as FileApiError).status).toBe(400);
  });
});
