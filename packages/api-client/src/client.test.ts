import { describe, expect, mock, test } from 'bun:test';
import { FeatureSet } from './capabilities';
import { ApiClient, defaultApiClient, parseApiError } from './client';

describe('ApiClient', () => {
  test('默认实例 baseUrl 为空（相对路径，同源）', () => {
    expect(defaultApiClient.baseUrl).toBe('');
    expect(defaultApiClient.url('/api/x')).toBe('/api/x');
  });

  test('注入 baseUrl 后 url 拼接前缀', () => {
    const client = new ApiClient('http://gw.example:1234');
    expect(client.url('/api/agent/sessions')).toBe('http://gw.example:1234/api/agent/sessions');
  });

  test('注入 transport 收到拼好 baseUrl 的 URL 与原始 init', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const transport = mock((input: string, init?: RequestInit) => {
      calls.push({ input, init });
      return Promise.resolve(new Response('ok', { status: 200 }));
    });
    const client = new ApiClient('http://gw.example:9', transport);
    const init: RequestInit = { method: 'POST', headers: { 'X-A': '1' }, body: 'x' };
    const res = await client.fetch('/api/ping', init);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe('http://gw.example:9/api/ping');
    expect(calls[0].init).toBe(init);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test('缺省 transport 在每次调用时 late-bound 读取 globalThis.fetch', async () => {
    const original = globalThis.fetch;
    const first = mock(() => Promise.resolve(new Response('1', { status: 201 })));
    const second = mock(() => Promise.resolve(new Response('2', { status: 202 })));
    try {
      globalThis.fetch = first as unknown as typeof fetch;
      const client = new ApiClient('');
      const r1 = await client.fetch('/a');
      expect(r1.status).toBe(201);
      expect(first).toHaveBeenCalledTimes(1);
      expect(first.mock.calls[0][0]).toBe('/a');

      globalThis.fetch = second as unknown as typeof fetch;
      const r2 = await client.fetch('/b', { method: 'GET' });
      expect(r2.status).toBe(202);
      expect(second).toHaveBeenCalledTimes(1);
      expect(second.mock.calls[0][0]).toBe('/b');
      // 构造后替换的 fetch 仍被使用；first 不再增加
      expect(first).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('有 transport 时不调用 globalThis.fetch', async () => {
    const original = globalThis.fetch;
    const globalFetch = mock(() => Promise.resolve(new Response('g', { status: 500 })));
    globalThis.fetch = globalFetch as unknown as typeof fetch;
    try {
      const transport = mock(() => Promise.resolve(new Response('t', { status: 204 })));
      const client = new ApiClient('http://x', transport);
      const res = await client.fetch('/z');
      expect(res.status).toBe(204);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(globalFetch).toHaveBeenCalledTimes(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('parseApiError', () => {
  test('解析 JSON error 字段', async () => {
    const res = new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
    expect(await parseApiError(res, 'fallback')).toBe('boom');
  });

  test('非 JSON 响应回退 fallback', async () => {
    const res = new Response('oops', { status: 500 });
    expect(await parseApiError(res, 'fallback')).toBe('fallback');
  });

  test('JSON 无 error 字段回退 fallback', async () => {
    const res = new Response(JSON.stringify({ ok: false }), { status: 500 });
    expect(await parseApiError(res, 'fallback')).toBe('fallback');
  });

  test('error 为对象时取其 message，不产出 [object Object]', async () => {
    const res = new Response(
      JSON.stringify({ error: { code: 'instance_offline', message: 'instance offline' } }),
      { status: 503 }
    );
    expect(await parseApiError(res, 'fallback')).toBe('instance offline');
  });

  test('error 为对象但无 message 字段回退 fallback', async () => {
    const res = new Response(JSON.stringify({ error: { code: 'x' } }), { status: 500 });
    expect(await parseApiError(res, 'fallback')).toBe('fallback');
  });
});

describe('FeatureSet', () => {
  test('has/hasAll/hasAny 判定', () => {
    const fs = new FeatureSet(['tmex-ws-borsh-v1', 'tmex-agent-v1']);
    expect(fs.has('tmex-agent-v1')).toBe(true);
    expect(fs.has('tmex-split-v1')).toBe(false);
    expect(fs.hasAll('tmex-ws-borsh-v1', 'tmex-agent-v1')).toBe(true);
    expect(fs.hasAll('tmex-ws-borsh-v1', 'tmex-split-v1')).toBe(false);
    expect(fs.hasAny('tmex-split-v1', 'tmex-agent-v1')).toBe(true);
    expect(fs.hasAny('tmex-split-v1')).toBe(false);
  });

  test('empty 与 list', () => {
    expect(FeatureSet.empty().list()).toEqual([]);
    expect(new FeatureSet(['a', 'a', 'b']).list().sort()).toEqual(['a', 'b']);
  });
});
