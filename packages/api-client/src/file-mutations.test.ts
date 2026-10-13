import { describe, expect, test } from 'bun:test';
import { ApiClient } from './client';
import { FileApiError } from './file-errors';
import {
  deleteFiles,
  isFileRouteUnsupported,
  moveFiles,
  prepareArchive,
  renameFile,
} from './file-mutations';

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

function expectPost(client: StubApiClient, path: string, body: unknown): void {
  expect(client.calls).toHaveLength(1);
  expect(client.calls[0].path).toBe(path);
  expect(client.calls[0].init?.method).toBe('POST');
  expect(client.calls[0].init?.headers).toEqual({ 'Content-Type': 'application/json' });
  expect(client.calls[0].init?.body).toBe(JSON.stringify(body));
}

describe('deleteFiles', () => {
  test('POST /api/files/delete，原样返回逐项结果', async () => {
    const payload = {
      results: [
        { path: '/srv/root/a', ok: true },
        { path: '/srv/root/b', ok: false, code: 'not_found' },
      ],
    };
    const client = new StubApiClient([jsonResponse(payload)]);
    const body = { rootId: 'r1', paths: ['/srv/root/a', '/srv/root/b'] };

    const result = await deleteFiles(body, client);

    expectPost(client, '/api/files/delete', body);
    expect(result).toEqual(payload);
  });

  test('400 invalid 抛 FileApiError，带 status 与 code', async () => {
    const client = new StubApiClient([
      jsonResponse({ error: 'invalid', code: 'invalid', detail: 'too_many_paths' }, 400),
    ]);

    const error = await deleteFiles({ rootId: 'r1', paths: [] }, client).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FileApiError);
    expect((error as FileApiError).status).toBe(400);
    expect((error as FileApiError).code).toBe('invalid');
  });
});

describe('moveFiles', () => {
  test('POST /api/files/move，请求体含 destDir 与 onConflict', async () => {
    const payload = { results: [{ path: '/srv/root/a', ok: true, dest: '/srv/root/d/a' }] };
    const client = new StubApiClient([jsonResponse(payload)]);
    const body = {
      rootId: 'r1',
      paths: ['/srv/root/a'],
      destRootId: 'r2',
      destDir: '/srv/root/d',
      onConflict: 'overwrite' as const,
    };

    const result = await moveFiles(body, client);

    expectPost(client, '/api/files/move', body);
    expect(result.results[0].dest).toBe('/srv/root/d/a');
  });

  test('请求级 400 invalid 抛 FileApiError 并带上 detail', async () => {
    const client = new StubApiClient([
      jsonResponse({ error: 'invalid', code: 'invalid', detail: 'cross_device' }, 400),
    ]);

    const error = await moveFiles(
      { rootId: 'r1', paths: ['/a'], destRootId: 'r9', destDir: '/d' },
      client
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FileApiError);
    expect((error as FileApiError).status).toBe(400);
    expect((error as FileApiError).code).toBe('invalid');
    expect((error as FileApiError).message).toBe('invalid');
    expect((error as FileApiError).detail).toBe('cross_device');
  });
});

describe('renameFile', () => {
  test('POST /api/files/rename，返回新路径', async () => {
    const client = new StubApiClient([jsonResponse({ path: '/srv/root/new.txt' })]);
    const body = { rootId: 'r1', path: '/srv/root/old.txt', name: 'new.txt' };

    const result = await renameFile(body, client);

    expectPost(client, '/api/files/rename', body);
    expect(result).toEqual({ path: '/srv/root/new.txt' });
  });

  test('409 already_exists 抛 FileApiError', async () => {
    const client = new StubApiClient([
      jsonResponse({ error: 'already_exists', code: 'already_exists' }, 409),
    ]);

    const error = await renameFile({ rootId: 'r1', path: '/srv/root/a', name: 'b' }, client).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(FileApiError);
    expect((error as FileApiError).status).toBe(409);
    expect((error as FileApiError).code).toBe('already_exists');
  });
});

describe('prepareArchive', () => {
  test('POST /api/files/archive/prepare，返回 archiveId 与文件名', async () => {
    const client = new StubApiClient([jsonResponse({ archiveId: 'tok_1', name: 'files.tar.gz' })]);
    const body = { rootId: 'r1', paths: ['/srv/root/a', '/srv/root/b'] };

    const result = await prepareArchive(body, client);

    expectPost(client, '/api/files/archive/prepare', body);
    expect(result).toEqual({ archiveId: 'tok_1', name: 'files.tar.gz' });
  });

  test('非 JSON 错误体回退为 HTTP 状态文案，无 code', async () => {
    const client = new StubApiClient([new Response('boom', { status: 502 })]);

    const error = await prepareArchive({ rootId: 'r1', paths: ['/a'] }, client).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(FileApiError);
    expect((error as FileApiError).message).toBe('HTTP 502');
    expect((error as FileApiError).code).toBeUndefined();
  });
});

describe('isFileRouteUnsupported', () => {
  test('404 route_not_found（网关不认识路由）→ true', async () => {
    const client = new StubApiClient([
      jsonResponse({ error: '未找到', code: 'route_not_found' }, 404),
    ]);

    const error = await deleteFiles({ rootId: 'r1', paths: ['/a'] }, client).catch(
      (e: unknown) => e
    );

    expect(isFileRouteUnsupported(error)).toBe(true);
  });

  test('404 无 code（更老的网关 / 反代）→ true', () => {
    expect(isFileRouteUnsupported(new FileApiError(404, 'Not Found'))).toBe(true);
  });

  test('404 属于文件业务码 → false', async () => {
    for (const code of ['not_found', 'device_not_found', 'root_not_found']) {
      const client = new StubApiClient([jsonResponse({ error: code, code }, 404)]);
      const error = await moveFiles({ rootId: 'r1', paths: ['/a'], destDir: '/d' }, client).catch(
        (e: unknown) => e
      );
      expect(isFileRouteUnsupported(error)).toBe(false);
    }
  });

  test('非 404 或非 FileApiError → false', () => {
    expect(isFileRouteUnsupported(new FileApiError(409, 'already_exists', 'already_exists'))).toBe(
      false
    );
    expect(isFileRouteUnsupported(new FileApiError(500, 'x'))).toBe(false);
    expect(isFileRouteUnsupported(new Error('HTTP 404'))).toBe(false);
    expect(isFileRouteUnsupported(null)).toBe(false);
  });
});
