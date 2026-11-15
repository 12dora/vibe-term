import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { POP_HEADER } from '@vibeterm/shared/http/mesh-headers';
import { ApiClient, type RequestPopProvider, setRequestPopProvider } from './client';
import { FakeXhr, resetFakeXhr } from './fake-xhr.testing';

const NODE = 'a'.repeat(32);
const originalXhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;

function popBody(code: string): Response {
  return new Response(JSON.stringify({ code }), { status: 401 });
}

function provider(overrides: Partial<RequestPopProvider> = {}): RequestPopProvider {
  let n = 0;
  return {
    sign: mock(() => Promise.resolve(`proof-${++n}`)),
    canSign: () => true,
    ...overrides,
  };
}

function recordingTransport(replies: Response[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const transport = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(replies.shift() ?? new Response('ok'));
  };
  return { calls, transport };
}

const popOf = (init?: RequestInit) => new Headers(init?.headers).get(POP_HEADER);

beforeEach(() => {
  resetFakeXhr();
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
});

afterEach(() => {
  setRequestPopProvider(null);
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = originalXhr;
});

describe('ApiClient PoP 请求头', () => {
  test('没有注册提供方时请求原样发出', async () => {
    const { calls, transport } = recordingTransport([new Response('ok')]);
    await new ApiClient('', transport).fetch('/api/x', { method: 'POST', headers: { 'X-A': '1' } });
    expect(popOf(calls[0].init)).toBeNull();
    expect(calls[0].init?.headers).toEqual({ 'X-A': '1' });
  });

  test('提供方同步返回 null：不签、不等待', async () => {
    setRequestPopProvider(provider({ sign: () => null }));
    const { calls, transport } = recordingTransport([new Response('ok')]);
    await new ApiClient('', transport).fetch('/api/x');
    expect(popOf(calls[0].init)).toBeNull();
  });

  test('带证明头发出，且保留调用方原有的头', async () => {
    const p = provider();
    setRequestPopProvider(p);
    const { calls, transport } = recordingTransport([new Response('ok')]);
    await new ApiClient('', transport).fetch('/api/x', {
      method: 'DELETE',
      headers: { 'X-A': '1' },
    });
    expect(popOf(calls[0].init)).toBe('proof-1');
    expect(new Headers(calls[0].init?.headers).get('x-a')).toBe('1');
    expect(p.sign).toHaveBeenCalledWith('DELETE', '/api/x');
  });

  test('转发路径：把带 /n/<id> 前缀的完整 URL 交给提供方（由它规范化）', async () => {
    const p = provider();
    setRequestPopProvider(p);
    const { transport } = recordingTransport([new Response('ok')]);
    await new ApiClient(`/n/${NODE}`, transport).fetch('/api/files?path=%2Ftmp');
    expect(p.sign).toHaveBeenCalledWith('GET', `/n/${NODE}/api/files?path=%2Ftmp`);
  });

  test('XHR 上传同样带证明头', async () => {
    const p = provider();
    setRequestPopProvider(p);
    await new ApiClient('').upload('/api/files/upload/u1', {
      method: 'PUT',
      body: new Blob(['abc']),
      headers: { 'X-A': '1' },
    });
    expect(FakeXhr.instances[0].sentHeaders).toEqual({ 'X-A': '1', [POP_HEADER]: 'proof-1' });
    expect(p.sign).toHaveBeenCalledWith('PUT', '/api/files/upload/u1');
  });
});

describe('POP 类 401：重签重试一次', () => {
  test('POP_INVALID 后重签重发，返回第二次的响应', async () => {
    const p = provider();
    setRequestPopProvider(p);
    const { calls, transport } = recordingTransport([popBody('POP_INVALID'), new Response('ok')]);
    const res = await new ApiClient('', transport).fetch('/api/x', {
      method: 'POST',
      body: '{"a":1}',
    });
    expect(res.status).toBe(200);
    expect(calls.map((call) => popOf(call.init))).toEqual(['proof-1', 'proof-2']);
    expect(calls[1].init?.body).toBe('{"a":1}');
  });

  test('第二次仍被拒绝就原样返回，不再重试', async () => {
    setRequestPopProvider(provider());
    const { calls, transport } = recordingTransport([
      popBody('POP_INVALID'),
      popBody('POP_INVALID'),
      new Response('never'),
    ]);
    const res = await new ApiClient('', transport).fetch('/api/x');
    expect(calls).toHaveLength(2);
    expect(res.status).toBe(401);
    expect((await res.json()) as { code: string }).toEqual({ code: 'POP_INVALID' });
  });

  test('POP_REQUIRED 同样重试；其他 401 不重试', async () => {
    setRequestPopProvider(provider());
    const required = recordingTransport([popBody('POP_REQUIRED'), new Response('ok')]);
    await new ApiClient('', required.transport).fetch('/api/x');
    expect(required.calls).toHaveLength(2);

    const other = recordingTransport([popBody('NODE_LOGIN_REQUIRED'), new Response('ok')]);
    const res = await new ApiClient('', other.transport).fetch('/api/x');
    expect(other.calls).toHaveLength(1);
    expect(res.status).toBe(401);
  });

  test('重签得到 null（钥没了）就不重发', async () => {
    let n = 0;
    setRequestPopProvider(
      provider({ sign: () => (++n === 1 ? Promise.resolve('proof-1') : Promise.resolve(null)) })
    );
    const { calls, transport } = recordingTransport([popBody('POP_INVALID'), new Response('ok')]);
    const res = await new ApiClient('', transport).fetch('/api/x');
    expect(calls).toHaveLength(1);
    expect(res.status).toBe(401);
  });

  test('流式请求体不可重放：不重试', async () => {
    setRequestPopProvider(provider());
    const { calls, transport } = recordingTransport([popBody('POP_INVALID'), new Response('ok')]);
    const body = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
    const res = await new ApiClient('', transport).fetch('/api/x', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit);
    expect(calls).toHaveLength(1);
    expect(res.status).toBe(401);
  });

  test('XHR 上传被拒后每次尝试各签一次', async () => {
    setRequestPopProvider(provider());
    let sends = 0;
    resetFakeXhr(() => {
      sends += 1;
      return sends === 1 ? { status: 401, body: '{"code":"POP_INVALID"}' } : { status: 200 };
    });
    const res = await new ApiClient('').upload('/api/u', { body: new Blob(['a']) });
    expect(res.status).toBe(200);
    expect(FakeXhr.instances.map((xhr) => xhr.sentHeaders[POP_HEADER])).toEqual([
      'proof-1',
      'proof-2',
    ]);
  });
});
