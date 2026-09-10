import { describe, expect, test } from 'bun:test';
import { ApiClient } from './client';
import { FileApiError } from './file-errors';
import { mkdirPath, reorderFileRoots } from './file-resources';

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

describe('mkdirPath', () => {
  test('POST /api/files/mkdir，请求体为 { rootId, path, recursive }', async () => {
    const client = new StubApiClient([jsonResponse({ path: '/srv/root/a/b', created: true })]);

    const result = await mkdirPath(
      { rootId: 'r1', path: '/srv/root/a/b', recursive: true },
      client
    );

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].path).toBe('/api/files/mkdir');
    expect(client.calls[0].init?.method).toBe('POST');
    expect(client.calls[0].init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(client.calls[0].init?.body).toBe(
      JSON.stringify({ rootId: 'r1', path: '/srv/root/a/b', recursive: true })
    );
    expect(result).toEqual({ path: '/srv/root/a/b', created: true });
  });

  test('省略 recursive 时请求体不含该字段', async () => {
    const client = new StubApiClient([jsonResponse({ path: '/srv/root/x', created: false })]);

    const result = await mkdirPath({ rootId: 'r1', path: '/srv/root/x' }, client);

    expect(client.calls[0].init?.body).toBe(JSON.stringify({ rootId: 'r1', path: '/srv/root/x' }));
    expect(result.created).toBe(false);
  });

  test('409 not_a_directory 抛 FileApiError', async () => {
    const client = new StubApiClient([
      jsonResponse({ error: 'not_a_directory', code: 'not_a_directory' }, 409),
    ]);

    const error = await mkdirPath({ rootId: 'r1', path: '/srv/root/file' }, client).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(FileApiError);
    expect((error as FileApiError).message).toBe('not_a_directory');
    expect((error as FileApiError).status).toBe(409);
    expect((error as FileApiError).code).toBe('not_a_directory');
  });
});
