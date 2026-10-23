import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ApiClient, addResponseHook, clearResponseHooks } from './client';
import { FakeXhr, resetFakeXhr } from './fake-xhr.testing';

const original = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;

beforeEach(() => {
  resetFakeXhr();
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
});

afterEach(() => {
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = original;
  clearResponseHooks();
});

describe('ApiClient.upload (XHR)', () => {
  test('拼 baseUrl、带头、汇报上行字节，返回带状态/头/体的真 Response', async () => {
    resetFakeXhr(() => ({
      progress: [3, 8, 99],
      status: 201,
      statusText: 'Created',
      headers: 'Content-Type: application/json\r\nX-Trace: abc\r\n',
      body: '{"ok":true}',
    }));
    const client = new ApiClient('http://gw.example:9');
    const loaded: number[] = [];

    const res = await client.upload('/api/files/upload/u1?offset=0&length=8', {
      method: 'PUT',
      body: new Blob([new Uint8Array(8)]),
      headers: { 'X-A': '1' },
      onUploadProgress: (n) => loaded.push(n),
    });

    const xhr = FakeXhr.instances[0];
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe('http://gw.example:9/api/files/upload/u1?offset=0&length=8');
    expect(xhr.sentHeaders).toEqual({ 'X-A': '1' });
    // 超出请求体大小的 loaded 被夹到 body.size
    expect(loaded).toEqual([3, 8, 8]);
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(201);
    expect(res.statusText).toBe('Created');
    expect(res.headers.get('x-trace')).toBe('abc');
    expect(await res.json()).toEqual({ ok: true });
    expect(client.lastLatencyMs()).not.toBeNull();
  });

  test('204 无体响应也能构造 Response', async () => {
    resetFakeXhr(() => ({ status: 204 }));
    const res = await new ApiClient('').upload('/x', { body: new Blob(['a']) });
    expect(res.status).toBe(204);
    expect(res.ok).toBe(true);
  });

  test('响应钩子收到 path / url / pathname（401 拦截与 fetch 同路径）', async () => {
    resetFakeXhr(() => ({ status: 401, body: '{"code":"NODE_LOGIN_REQUIRED"}' }));
    const hook = mock(
      (_res: Response, _ctx: { path: string; url: string; pathname: string }) => {}
    );
    addResponseHook(hook);
    const client = new ApiClient('/n/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    const res = await client.upload('/api/files/upload/u?offset=0&length=1', {
      method: 'PUT',
      body: new Blob(['a']),
    });

    expect(res.status).toBe(401);
    expect(hook).toHaveBeenCalledTimes(1);
    const ctx = hook.mock.calls[0][1];
    expect(ctx.path).toBe('/api/files/upload/u?offset=0&length=1');
    expect(ctx.pathname).toBe('/n/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/api/files/upload/u');
  });

  test('signal 中止 → xhr.abort() 且抛 AbortError；已中止的 signal 不发请求', async () => {
    resetFakeXhr(() => ({ outcome: 'hang' }));
    const controller = new AbortController();
    const client = new ApiClient('');
    const pending = client.upload('/x', { body: new Blob(['a']), signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    const error = await pending.catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    expect(FakeXhr.instances[0].aborted).toBe(true);

    const before = FakeXhr.instances.length;
    const again = await client
      .upload('/x', { body: new Blob(['a']), signal: controller.signal })
      .catch((e: unknown) => e);
    expect((again as Error).name).toBe('AbortError');
    expect(FakeXhr.instances.length).toBe(before);
  });

  test('网络错误 → TypeError，与 fetch 一致', async () => {
    resetFakeXhr(() => ({ outcome: 'error' }));
    const error = await new ApiClient('')
      .upload('/x', { body: new Blob(['a']) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
  });

  test('注入了自定义 transport 时退回 fetch：不碰 XHR，请求体送达后只汇报一次', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApiClient('http://gw', async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 200 });
    });
    const loaded: number[] = [];
    const res = await client.upload('/x', {
      method: 'PUT',
      body: new Blob([new Uint8Array(5)]),
      onUploadProgress: (n) => loaded.push(n),
    });
    expect(res.status).toBe(200);
    expect(FakeXhr.instances).toHaveLength(0);
    expect(calls[0].url).toBe('http://gw/x');
    expect(calls[0].init?.method).toBe('PUT');
    expect(loaded).toEqual([5]);
  });

  test('没有 XMLHttpRequest 时同样退回 fetch；失败响应不汇报', async () => {
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response('no', { status: 500 })) as never;
    try {
      const loaded: number[] = [];
      const res = await new ApiClient('').upload('/x', {
        body: new Blob(['abc']),
        onUploadProgress: (n) => loaded.push(n),
      });
      expect(res.status).toBe(500);
      expect(loaded).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('请求门同时作用于 upload()：admit 抛错则不发 XHR，成功 / 失败分别回调', async () => {
    const events: string[] = [];
    const client = new ApiClient('', undefined, {
      admit: ({ method }) => {
        events.push(`admit ${method}`);
        if (method === 'POST') throw new Error('blocked');
      },
      onResponse: (res) => events.push(`response ${res.status}`),
      onFailure: (err) => events.push(`failure ${(err as Error).name}`),
    });

    resetFakeXhr(() => ({ status: 200 }));
    await client.upload('/x', { method: 'PUT', body: new Blob(['a']) });
    resetFakeXhr(() => ({ outcome: 'error' }));
    await client.upload('/x', { method: 'PUT', body: new Blob(['a']) }).catch(() => undefined);
    const before = FakeXhr.instances.length;
    await expect(client.upload('/x', { body: new Blob(['a']) })).rejects.toThrow('blocked');

    expect(events).toEqual([
      'admit PUT',
      'response 200',
      'admit PUT',
      'failure TypeError',
      'admit POST',
    ]);
    expect(FakeXhr.instances.length).toBe(before);
  });
});
