import { describe, expect, test } from 'bun:test';
import {
  ShareAccessError,
  type ShareFetch,
  getShareAccess,
  loginShareAccess,
  logoutShareAccess,
  parseShareAccessInfo,
  shareAccessErrorFrom,
  shareAccessUrl,
} from './access-client';

const NODE_BASE = `/n/${'a'.repeat(32)}`;

interface Call {
  url: string;
  init?: RequestInit;
}

function stub(status: number, body: unknown): { fetch: ShareFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: ShareFetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    );
  };
  return { fetch: fetchImpl, calls };
}

describe('shareAccessUrl', () => {
  test('self 无前缀，shareId 经编码', () => {
    expect(shareAccessUrl('', 'a/b')).toBe('/api/share-access/a%2Fb');
  });

  test('带 node 前缀与子路径', () => {
    expect(shareAccessUrl(NODE_BASE, 'abc', '/login')).toBe(
      `${NODE_BASE}/api/share-access/abc/login`
    );
  });
});

describe('shareAccessErrorFrom', () => {
  test.each([
    [401, {}, 'SHARE_PASSWORD_INVALID'],
    [404, {}, 'SHARE_NOT_FOUND'],
    [410, {}, 'SHARE_ENDED'],
    [429, {}, 'SHARE_LOGIN_LOCKED'],
    [500, {}, 'SHARE_REQUEST_FAILED'],
  ] as const)('%i → %s', (status, body, code) => {
    expect(shareAccessErrorFrom(status, body).code).toBe(code);
  });

  test('错误体里的契约码优先于状态码', () => {
    expect(shareAccessErrorFrom(400, { code: 'SHARE_ENDED' }).code).toBe('SHARE_ENDED');
  });

  test('未知契约码回落到状态码', () => {
    expect(shareAccessErrorFrom(404, { code: 'WHATEVER' }).code).toBe('SHARE_NOT_FOUND');
  });

  test('锁定带上 retryAfterMs，其余为 null', () => {
    expect(shareAccessErrorFrom(429, { retryAfterMs: 900_000 }).retryAfterMs).toBe(900_000);
    expect(shareAccessErrorFrom(429, { retryAfterMs: -1 }).retryAfterMs).toBeNull();
    expect(shareAccessErrorFrom(401, { retryAfterMs: 900_000 }).retryAfterMs).toBeNull();
  });
});

describe('parseShareAccessInfo', () => {
  test('未认证时不带 deviceId / windowId', () => {
    expect(parseShareAccessInfo({ id: 'x', name: 'demo', state: 'active' }, 'x')).toEqual({
      id: 'x',
      name: 'demo',
      state: 'active',
      expiresAt: null,
      authenticated: false,
      deviceId: undefined,
      windowId: undefined,
    });
  });

  test('缺字段时回落到传入的 shareId 与 active', () => {
    const info = parseShareAccessInfo(null, 'fallback');
    expect(info.id).toBe('fallback');
    expect(info.state).toBe('active');
    expect(info.name).toBe('');
  });

  test('已认证带上作用域', () => {
    const info = parseShareAccessInfo(
      { authenticated: true, deviceId: 'd1', windowId: '@3', expiresAt: 42 },
      'x'
    );
    expect(info).toMatchObject({
      authenticated: true,
      deviceId: 'd1',
      windowId: '@3',
      expiresAt: 42,
    });
  });
});

describe('getShareAccess', () => {
  test('GET 到 node 前缀下的公开端点', async () => {
    const { fetch, calls } = stub(200, { id: 'abc', name: 'demo', state: 'active' });
    const info = await getShareAccess(NODE_BASE, 'abc', fetch);
    expect(calls[0].url).toBe(`${NODE_BASE}/api/share-access/abc`);
    expect(calls[0].init?.method).toBe('GET');
    expect(calls[0].init?.credentials).toBe('same-origin');
    expect(info.name).toBe('demo');
  });

  test('404 抛 SHARE_NOT_FOUND', async () => {
    const { fetch } = stub(404, { code: 'SHARE_NOT_FOUND' });
    expect(getShareAccess('', 'abc', fetch)).rejects.toThrow(ShareAccessError);
    await getShareAccess('', 'abc', fetch).catch((error: ShareAccessError) => {
      expect(error.code).toBe('SHARE_NOT_FOUND');
    });
  });

  test('网络异常归一成 SHARE_REQUEST_FAILED', async () => {
    const failing: ShareFetch = () => Promise.reject(new Error('offline'));
    await getShareAccess('', 'abc', failing).catch((error: ShareAccessError) => {
      expect(error.code).toBe('SHARE_REQUEST_FAILED');
      expect(error.status).toBe(0);
    });
  });
});

describe('loginShareAccess', () => {
  test('POST 密码到 /login', async () => {
    const { fetch, calls } = stub(200, { ok: true, expiresAt: 99 });
    const result = await loginShareAccess('', 'abc', 'hunter2', fetch);
    expect(calls[0].url).toBe('/api/share-access/abc/login');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBe(JSON.stringify({ password: 'hunter2' }));
    expect(result.expiresAt).toBe(99);
  });

  test('429 带回锁定剩余时间', async () => {
    const { fetch } = stub(429, { code: 'SHARE_LOGIN_LOCKED', retryAfterMs: 900_000 });
    await loginShareAccess('', 'abc', 'x', fetch).catch((error: ShareAccessError) => {
      expect(error.code).toBe('SHARE_LOGIN_LOCKED');
      expect(error.retryAfterMs).toBe(900_000);
    });
  });

  test('410 即分享已结束', async () => {
    const { fetch } = stub(410, { code: 'SHARE_ENDED' });
    await loginShareAccess('', 'abc', 'x', fetch).catch((error: ShareAccessError) => {
      expect(error.code).toBe('SHARE_ENDED');
    });
  });
});

describe('logoutShareAccess', () => {
  test('POST 到 /logout', async () => {
    const { fetch, calls } = stub(200, { ok: true });
    await logoutShareAccess(NODE_BASE, 'abc', fetch);
    expect(calls[0].url).toBe(`${NODE_BASE}/api/share-access/abc/logout`);
    expect(calls[0].init?.method).toBe('POST');
  });
});
