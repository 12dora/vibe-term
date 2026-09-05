import { describe, expect, test } from 'bun:test';
import { ApiClient, ApiError } from './client';
import {
  createShare,
  getShareOrigins,
  listShares,
  revokeShare,
  shareListPath,
  shareQueryKey,
} from './share';
import { shareErrorKey } from './share-errors';

class StubApiClient extends ApiClient {
  calls: Array<{ path: string; init?: RequestInit }> = [];

  constructor(
    private responses: Response[],
    baseUrl = ''
  ) {
    super(baseUrl);
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

describe('shareListPath', () => {
  test('无过滤时不带查询串', () => {
    expect(shareListPath()).toBe('/api/share');
    expect(shareListPath({})).toBe('/api/share');
  });

  test('按 deviceId / windowId 拼查询串并转义', () => {
    expect(shareListPath({ deviceId: 'd1', windowId: '@1' })).toBe(
      '/api/share?deviceId=d1&windowId=%401'
    );
    expect(shareListPath({ deviceId: 'd1' })).toBe('/api/share?deviceId=d1');
    expect(shareListPath({ windowId: '@2' })).toBe('/api/share?windowId=%402');
  });
});

describe('shareQueryKey', () => {
  test('缺省过滤补 null，保证同一形状便于失效', () => {
    expect(shareQueryKey()).toEqual(['share', null, null]);
    expect(shareQueryKey({ deviceId: 'd1', windowId: '@1' })).toEqual(['share', 'd1', '@1']);
  });
});

describe('listShares', () => {
  test('GET 列表并保留 { active, history } 信封', async () => {
    const client = new StubApiClient([
      jsonResponse({ active: [{ id: 's1' }], history: [{ id: 's0' }] }),
    ]);

    const result = await listShares(client, { deviceId: 'd1', windowId: '@1' });

    expect(client.calls[0].path).toBe('/api/share?deviceId=d1&windowId=%401');
    expect(client.calls[0].init).toBeUndefined();
    expect(result.active).toHaveLength(1);
    expect(result.history[0].id).toBe('s0');
  });

  test('透传 AbortSignal', async () => {
    const client = new StubApiClient([jsonResponse({ active: [], history: [] })]);
    const controller = new AbortController();

    await listShares(client, {}, controller.signal);

    expect(client.calls[0].init?.signal).toBe(controller.signal);
  });

  test('非 2xx 抛错，缺 error 字段时用 fallback', async () => {
    const client = new StubApiClient([jsonResponse({ error: 'boom' }, 500)]);
    await expect(listShares(client)).rejects.toThrow('boom');

    const bare = new StubApiClient([new Response('oops', { status: 500 })]);
    await expect(listShares(bare)).rejects.toThrow('Failed to load shares');
  });

  test('走 node 前缀 baseUrl', async () => {
    const client = new StubApiClient([jsonResponse({ active: [], history: [] })], '/n/abc');
    await listShares(client, { deviceId: 'd1' });
    expect(client.url(client.calls[0].path)).toBe('/n/abc/api/share?deviceId=d1');
  });
});

describe('createShare', () => {
  const input = {
    deviceId: 'd1',
    windowId: '@1',
    name: 'build',
    password: 'abcdef',
    expiresInMs: 86_400_000,
    origin: 'https://example.com',
  };

  test('POST /api/share，body 原样序列化，返回 { share, password }', async () => {
    const client = new StubApiClient([jsonResponse({ share: { id: 's1' }, password: 'abcdef' })]);

    const result = await createShare(client, input);

    expect(client.calls[0].path).toBe('/api/share');
    expect(client.calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(client.calls[0].init?.body))).toEqual(input);
    expect(result.password).toBe('abcdef');
    expect(result.share.id).toBe('s1');
  });

  test('永久分享传 expiresInMs: null', async () => {
    const client = new StubApiClient([jsonResponse({ share: { id: 's1' }, password: 'x' })]);
    await createShare(client, { ...input, expiresInMs: null });
    expect(JSON.parse(String(client.calls[0].init?.body)).expiresInMs).toBeNull();
  });

  test('契约错误码走 message 解析', async () => {
    const client = new StubApiClient([
      jsonResponse({ error: 'password too short', code: 'SHARE_PASSWORD_TOO_SHORT' }, 400),
    ]);
    await expect(createShare(client, input)).rejects.toThrow('password too short');
  });

  // 服务端 message 是英文，界面必须能按码翻译，所以错误里要留住 code
  test('抛出的是带 code 的 ApiError，可直接映射到 i18n key', async () => {
    const client = new StubApiClient([
      jsonResponse({ error: 'window closed', code: 'SHARE_WINDOW_NOT_FOUND' }, 404),
    ]);

    const error = await createShare(client, input).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('SHARE_WINDOW_NOT_FOUND');
    expect((error as ApiError).status).toBe(404);
    expect(shareErrorKey(error)).toBe('share.error.SHARE_WINDOW_NOT_FOUND');
  });
});

describe('revokeShare', () => {
  test('POST /api/share/:id/revoke，拆 { share } 信封', async () => {
    const client = new StubApiClient([jsonResponse({ share: { id: 's1', state: 'ended' } })]);

    const share = await revokeShare(client, 's1');

    expect(client.calls[0].path).toBe('/api/share/s1/revoke');
    expect(client.calls[0].init?.method).toBe('POST');
    expect(client.calls[0].init?.body).toBeUndefined();
    expect(share.state).toBe('ended');
  });

  test('id 进路径前转义', async () => {
    const client = new StubApiClient([jsonResponse({ share: { id: 'a/b' } })]);
    await revokeShare(client, 'a/b');
    expect(client.calls[0].path).toBe('/api/share/a%2Fb/revoke');
  });
});

describe('getShareOrigins', () => {
  test('GET /api/share/origins', async () => {
    const payload = {
      candidates: [{ url: 'https://a.example', kind: 'site', label: 'a.example' }],
      recommended: 'https://a.example',
      nodePrefix: null,
    };
    const client = new StubApiClient([jsonResponse(payload)]);

    const result = await getShareOrigins(client);

    expect(client.calls[0].path).toBe('/api/share/origins');
    expect(result.recommended).toBe('https://a.example');
    expect(result.candidates[0].kind).toBe('site');
  });
});
