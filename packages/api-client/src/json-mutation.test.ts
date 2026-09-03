import { describe, expect, test } from 'bun:test';
import { ApiClient } from './client';
import { FileApiError, parseError } from './file-errors';
import { readCodedError, requestJson, requestOk } from './json-mutation';

class StubApiClient extends ApiClient {
  calls: Array<{ path: string; init?: RequestInit }> = [];

  constructor(private readonly responses: Array<Response | Error>) {
    super('');
  }

  override fetch(path: string, init?: RequestInit): Promise<Response> {
    this.calls.push({ path, init });
    const next = this.responses.shift();
    if (!next) return Promise.reject(new Error('unexpected request'));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('requestJson 成功路径', () => {
  test('GET 不带 body 时不拼 init，整体返回响应体', async () => {
    const client = new StubApiClient([jsonResponse({ roots: [{ id: 'r-1' }] })]);

    const result = await requestJson<{ roots: Array<{ id: string }> }>(
      client,
      '/api/files/roots',
      {}
    );

    expect(client.calls[0].path).toBe('/api/files/roots');
    expect(client.calls[0].init).toBeUndefined();
    expect(result.roots.map((r) => r.id)).toEqual(['r-1']);
  });

  test('带 body 时自动附 JSON 头并序列化，pick 拆信封', async () => {
    const client = new StubApiClient([jsonResponse({ device: { id: 'dev-1' } }, 201)]);

    const device = await requestJson<{ device: { id: string } }, { id: string }>(
      client,
      '/api/devices',
      {
        method: 'POST',
        body: { name: 'vm' },
        pick: (payload) => payload.device,
      }
    );

    expect(client.calls[0].init?.method).toBe('POST');
    expect(client.calls[0].init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(client.calls[0].init?.body).toBe(JSON.stringify({ name: 'vm' }));
    expect(device.id).toBe('dev-1');
  });

  test('signal 透传给底层 fetch', async () => {
    const client = new StubApiClient([jsonResponse({})]);
    const controller = new AbortController();

    await requestJson(client, '/api/x', { signal: controller.signal });

    expect(client.calls[0].init?.signal).toBe(controller.signal);
  });
});

describe('requestJson 错误路径', () => {
  test('非 2xx 且响应体带 error 字段时抛该文案', async () => {
    const client = new StubApiClient([jsonResponse({ error: 'ssh requires host' }, 400)]);

    await expect(
      requestJson(client, '/api/devices', { method: 'POST', body: {}, errorFallback: '创建失败' })
    ).rejects.toThrow('ssh requires host');
  });

  test('非 2xx 且响应体是纯文本时退化为 fallback', async () => {
    const client = new StubApiClient([new Response('<html>502</html>', { status: 502 })]);

    await expect(
      requestJson(client, '/api/devices', { errorFallback: '加载失败' })
    ).rejects.toThrow('加载失败');
  });

  test('未给 errorFallback 时用状态码兜底', async () => {
    const client = new StubApiClient([new Response('oops', { status: 503 })]);

    await expect(requestJson(client, '/api/devices')).rejects.toThrow('HTTP 503');
  });

  test('toError 决定抛出的错误类型，保留原有错误形状', async () => {
    const client = new StubApiClient([jsonResponse({ error: 'invalid request' }, 400)]);

    const error = await requestJson(client, '/api/files/roots/order', {
      method: 'PUT',
      body: { rootIds: [] },
      toError: parseError,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FileApiError);
    expect((error as FileApiError).message).toBe('invalid request');
    expect((error as FileApiError).status).toBe(400);
  });

  test('网络异常原样上抛，不被错误工厂吞掉', async () => {
    const client = new StubApiClient([new TypeError('Failed to fetch')]);

    await expect(
      requestJson(client, '/api/devices', { errorFallback: '加载失败' })
    ).rejects.toThrow('Failed to fetch');
  });

  test('allowStatus 命中的状态码不抛错，交回调用方判定', async () => {
    const client = new StubApiClient([jsonResponse({ error: 'gone' }, 404)]);

    const res = await requestOk(client, '/api/agent/sessions/s-1', {
      errorFallback: 'Failed to load agent session',
      allowStatus: [404],
    });

    expect(res.status).toBe(404);
  });
});

describe('requestOk', () => {
  test('204 空响应体不解析 JSON，直接返回响应', async () => {
    const client = new StubApiClient([new Response(null, { status: 204 })]);

    const res = await requestOk(client, '/api/devices/dev-1', { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(client.calls[0].init?.method).toBe('DELETE');
    expect(client.calls[0].init?.body).toBeUndefined();
  });

  test('非 2xx 走同一套错误映射', async () => {
    const client = new StubApiClient([jsonResponse({ error: 'not found' }, 404)]);

    await expect(
      requestOk(client, '/api/devices/dev-1', { method: 'DELETE', errorFallback: '删除失败' })
    ).rejects.toThrow('not found');
  });
});

describe('readCodedError', () => {
  test('契约错误体解出 code / message / status', async () => {
    const res = jsonResponse({ error: { code: 'unauthorized', message: 'login required' } }, 401);

    const err = await readCodedError(res, 'tls_failed', (code, message, status) => ({
      code,
      message,
      status,
    }));

    expect(err).toEqual({ code: 'unauthorized', message: 'login required', status: 401 });
  });

  test('message 缺失时用 code 顶替', async () => {
    const res = jsonResponse({ error: { code: 'not_applicable' } }, 409);

    const err = await readCodedError(res, 'tls_failed', (code, message) => ({ code, message }));

    expect(err).toEqual({ code: 'not_applicable', message: 'not_applicable' });
  });

  test('兼容 `{error: "..."}` 老形态', async () => {
    const res = jsonResponse({ error: 'boom' }, 500);

    const err = await readCodedError(res, 'tls_failed', (code, message) => ({ code, message }));

    expect(err).toEqual({ code: 'boom', message: 'boom' });
  });

  test('响应体不可解析时退化为 fallback', async () => {
    const res = new Response('<html>502</html>', { status: 502 });

    const err = await readCodedError(res, 'local_status_failed', (code, message, status) => ({
      code,
      message,
      status,
    }));

    expect(err).toEqual({
      code: 'local_status_failed',
      message: 'local_status_failed',
      status: 502,
    });
  });
});
