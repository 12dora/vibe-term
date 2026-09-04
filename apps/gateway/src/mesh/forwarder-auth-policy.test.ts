import { describe, expect, test } from 'bun:test';
import { AUTH_LOGIN_PATH, AUTH_SKIP, applyAuthPolicy, peekJsonCode } from './forwarder-auth-policy';
import { AUTH_401_BODY_LIMIT, X_TMEX_SESSION_RENEWED, X_TMEX_SET_SESSION } from './mesh-deps';

const OTHER = 'bb'.repeat(16);

function headersFrom(upstream: Response): Headers {
  const headers = new Headers();
  headers.set('content-type', upstream.headers.get('content-type') ?? 'application/json');
  for (const name of ['content-length', 'content-range', 'etag', 'content-disposition']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

describe('applyAuthPolicy', () => {
  test('带了 cookie 却被判无效的 401：补上 NODE_LOGIN_REQUIRED 并清 cookie', async () => {
    const upstream = new Response(JSON.stringify({ error: 'via_mismatch' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    const res = await applyAuthPolicy(
      new Request(`http://localhost/n/${OTHER}/api/devices`, {
        headers: { cookie: `tmex_s_${OTHER}=stale` },
      }),
      headersFrom(upstream),
      upstream,
      OTHER
    );
    expect(res).not.toBeNull();
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({
      error: 'via_mismatch',
      code: 'NODE_LOGIN_REQUIRED',
      nodeId: OTHER,
    });
    const cookie = res?.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`tmex_s_${OTHER}=`);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie.includes('Secure')).toBe(false);
  });

  test('请求没带 cookie 的 401 不清 cookie：登录前并发发出的请求不能删掉刚签发的会话', async () => {
    const upstream = new Response(JSON.stringify({ error: 'missing auth' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    const res = await applyAuthPolicy(
      new Request(`http://localhost/n/${OTHER}/api/devices`),
      headersFrom(upstream),
      upstream,
      OTHER
    );
    expect(res?.status).toBe(401);
    expect(await res?.json()).toMatchObject({ code: 'NODE_LOGIN_REQUIRED', nodeId: OTHER });
    expect(res?.headers.get('set-cookie')).toBeNull();
  });

  test('带了 cookie 但目标说 missing auth（cookie 未被转发）也不清', async () => {
    const upstream = new Response(JSON.stringify({ error: 'missing auth' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    const res = await applyAuthPolicy(
      new Request(`http://localhost/n/${OTHER}/api/devices`, {
        headers: { cookie: `tmex_s_${OTHER}=fresh` },
      }),
      headersFrom(upstream),
      upstream,
      OTHER
    );
    expect(res?.status).toBe(401);
    expect(res?.headers.get('set-cookie')).toBeNull();
  });

  test('skip401Rewrite 时登录 401 不改写、不发清 cookie', async () => {
    const upstream = new Response(JSON.stringify({ code: 'INVALID_CREDENTIALS' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    const res = await applyAuthPolicy(
      new Request(`http://localhost/n/${OTHER}${AUTH_LOGIN_PATH}`, { method: 'POST' }),
      headersFrom(upstream),
      upstream,
      OTHER,
      AUTH_SKIP.has(AUTH_LOGIN_PATH)
    );
    expect(res).toBeNull();
  });

  test('https 401 via_mismatch 清 cookie 带 Secure', async () => {
    const upstream = new Response(JSON.stringify({ error: 'via_mismatch' }), { status: 401 });
    const res = await applyAuthPolicy(
      new Request(`https://entry.example/n/${OTHER}/api/devices`, {
        headers: { cookie: `tmex_s_${OTHER}=stale-sid` },
      }),
      headersFrom(upstream),
      upstream,
      OTHER
    );
    expect(await res?.json()).toEqual({
      error: 'via_mismatch',
      code: 'NODE_LOGIN_REQUIRED',
      nodeId: OTHER,
    });
    expect(res?.headers.get('set-cookie')).toBe(
      `tmex_s_${OTHER}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`
    );
  });

  test('x-tmex-set-session 变成 Set-Cookie，且 200 返回 null', async () => {
    const upstream = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        [X_TMEX_SET_SESSION]: 'sessidvalue;64800',
      },
    });
    const headers = new Headers({ 'content-type': 'application/json' });
    const res = await applyAuthPolicy(
      new Request(`http://localhost/n/${OTHER}${AUTH_LOGIN_PATH}`, { method: 'POST' }),
      headers,
      upstream,
      OTHER,
      true
    );
    expect(res).toBeNull();
    const cookie = headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`tmex_s_${OTHER}=sessidvalue`);
    expect(cookie).toContain('Max-Age=64800');
  });

  test('x-tmex-session-renewed 续期已有 cookie', async () => {
    const expiresAt = Date.now() + 30_000;
    const upstream = new Response('{}', {
      status: 200,
      headers: { [X_TMEX_SESSION_RENEWED]: String(expiresAt) },
    });
    const headers = new Headers();
    const res = await applyAuthPolicy(
      new Request(`http://localhost/n/${OTHER}/api/devices`, {
        headers: { cookie: `tmex_s_${OTHER}=live-sid` },
      }),
      headers,
      upstream,
      OTHER
    );
    expect(res).toBeNull();
    expect(headers.get(X_TMEX_SESSION_RENEWED)).toBe(String(expiresAt));
    const cookie = headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`tmex_s_${OTHER}=live-sid`);
    expect(cookie).toContain('Max-Age=');
  });

  test('401 最多读 64 KiB 并丢掉 representation 头', async () => {
    const huge = 'x'.repeat(80 * 1024);
    const upstream = new Response(huge, {
      status: 401,
      headers: {
        'content-type': 'text/plain',
        'content-length': String(huge.length),
        'content-range': 'bytes 0-10/11',
        etag: '"abc"',
        'content-disposition': 'inline',
      },
    });
    const headers = headersFrom(upstream);
    const res = await applyAuthPolicy(
      new Request(`http://localhost/n/${OTHER}/api/devices`),
      headers,
      upstream,
      OTHER
    );
    expect(res?.headers.get('content-length')).toBeNull();
    expect(res?.headers.get('content-range')).toBeNull();
    expect(res?.headers.get('etag')).toBeNull();
    expect(res?.headers.get('content-disposition')).toBeNull();
    const body = (await res?.json()) as { message?: string; code: string; nodeId: string };
    expect(body.code).toBe('NODE_LOGIN_REQUIRED');
    expect(body.nodeId).toBe(OTHER);
    expect(body.message?.length).toBe(AUTH_401_BODY_LIMIT);
  });

  test('非规范 nodeId 的 401 不发 Set-Cookie', async () => {
    const upstream = new Response(JSON.stringify({ error: 'no' }), { status: 401 });
    const res = await applyAuthPolicy(
      new Request('http://localhost/n/self=/api/devices'),
      new Headers(),
      upstream,
      'self='
    );
    expect(res?.status).toBe(401);
    expect(res?.headers.get('set-cookie')).toBeNull();
    expect(await res?.json()).toMatchObject({ code: 'NODE_LOGIN_REQUIRED', nodeId: 'self=' });
  });
});

describe('peekJsonCode', () => {
  test('读 code 或 error，畸形体返回空串', async () => {
    expect(await peekJsonCode(new Response(JSON.stringify({ code: 'TOTP_REQUIRED' })))).toBe(
      'TOTP_REQUIRED'
    );
    expect(await peekJsonCode(new Response(JSON.stringify({ error: 'PASSKEY_REQUIRED' })))).toBe(
      'PASSKEY_REQUIRED'
    );
    expect(await peekJsonCode(new Response('not-json'))).toBe('');
    expect(await peekJsonCode(new Response(JSON.stringify(['x'])))).toBe('');
  });
});
