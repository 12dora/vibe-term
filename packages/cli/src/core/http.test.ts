import { describe, expect, test } from 'bun:test';
import { SESSION_RENEWED_HEADER, SET_SESSION_HEADER } from '@vibeterm/shared/http/mesh-headers';
import { AuthError, NetworkError, NotFoundError } from './errors';
import {
  type FetchLike,
  HttpClient,
  createMemoryCookieJar,
  parseSessionSetCookie,
  parseSetSessionHeader,
} from './http';

const ENTRY = 'http://entry.example:9883';
const NODE = 'a'.repeat(32);

function client(fetchImpl: FetchLike, jar = createMemoryCookieJar()): HttpClient {
  return new HttpClient({ entry: ENTRY, timeoutMs: 1000, jar, fetchImpl });
}

describe('cookie parsing', () => {
  test('reads the session cookie and its max-age', () => {
    expect(parseSessionSetCookie('vibeterm_s_self=abc; Path=/; Max-Age=60; HttpOnly')).toEqual({
      nodeId: 'self',
      sid: 'abc',
      maxAgeSec: 60,
    });
  });

  test('accepts the tmex-era prefix', () => {
    expect(parseSessionSetCookie(`tmex_s_${NODE}=xyz; Max-Age=0`)?.nodeId).toBe(NODE);
  });

  test('ignores unrelated cookies', () => {
    expect(parseSessionSetCookie('share_abc=1; Path=/')).toBeNull();
  });

  test('parses the internal set-session header', () => {
    expect(parseSetSessionHeader('sid-1;3600')).toEqual({ sid: 'sid-1', maxAgeSec: 3600 });
    expect(parseSetSessionHeader(';0')).toEqual({ sid: '', maxAgeSec: 0 });
    expect(parseSetSessionHeader('garbage')).toBeNull();
  });
});

describe('HttpClient', () => {
  test('routes node paths through the entry and pins Origin', async () => {
    const seen: Array<{ url: string; origin: string | null }> = [];
    const http = client(async (url, init) => {
      seen.push({ url, origin: new Headers(init?.headers).get('origin') });
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    await http.json(NODE, 'GET', '/api/devices');
    expect(seen[0].url).toBe(`${ENTRY}/n/${NODE}/api/devices`);
    expect(seen[0].origin).toBe(ENTRY);
  });

  test('stores Set-Cookie sessions and replays them per node', async () => {
    const jar = createMemoryCookieJar();
    const http = client(
      async (url) =>
        url.includes('/api/auth/login')
          ? new Response('{}', {
              headers: {
                'content-type': 'application/json',
                'set-cookie': `vibeterm_s_${NODE}=sid-node; Path=/; Max-Age=60`,
              },
            })
          : new Response('{}', { headers: { 'content-type': 'application/json' } }),
      jar
    );
    jar.set('self', 'sid-self', 0);
    await http.json(NODE, 'POST', '/api/auth/login', {});
    expect(jar.get(NODE)?.sid).toBe('sid-node');

    const header = http.cookieHeader(NODE);
    expect(header).toContain('vibeterm_s_self=sid-self');
    expect(header).toContain(`vibeterm_s_${NODE}=sid-node`);
    expect(header).toContain(`tmex_s_${NODE}=sid-node`);
  });

  test('captures the internal set-session header when no cookie is set', async () => {
    const jar = createMemoryCookieJar();
    const http = client(
      async () =>
        new Response('{}', {
          headers: { 'content-type': 'application/json', [SET_SESSION_HEADER.name]: 'sid-x;120' },
        }),
      jar
    );
    await http.json('self', 'POST', '/api/auth/login', {});
    expect(jar.get('self')?.sid).toBe('sid-x');
    expect(jar.get('self')?.expiresAt).toBeGreaterThan(Date.now());
  });

  test('an empty set-session header clears the session (logout)', async () => {
    const jar = createMemoryCookieJar();
    jar.set('self', 'sid-old', Date.now() + 1000);
    const http = client(
      async () =>
        new Response('{}', {
          headers: { 'content-type': 'application/json', [SET_SESSION_HEADER.name]: ';0' },
        }),
      jar
    );
    await http.json('self', 'POST', '/api/auth/logout');
    expect(jar.get('self')).toBeNull();
  });

  test('session-renewed pushes the local expiry out', async () => {
    const jar = createMemoryCookieJar();
    jar.set('self', 'sid', 1);
    const renewed = Date.now() + 900_000;
    const http = client(
      async () =>
        new Response('{}', {
          headers: {
            'content-type': 'application/json',
            [SESSION_RENEWED_HEADER.name]: String(renewed),
          },
        }),
      jar
    );
    await http.json('self', 'GET', '/api/devices');
    expect(jar.get('self')?.expiresAt).toBe(renewed);
    expect(jar.get('self')?.sid).toBe('sid');
  });

  test('401 becomes an auth error pointing at the right login command', async () => {
    const http = client(
      async () =>
        new Response(JSON.stringify({ error: 'NODE_LOGIN_REQUIRED', nodeId: NODE }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
    );
    const error = await http.json(NODE, 'GET', '/api/devices').catch((err) => err);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).exitCode).toBe(3);
    expect((error as AuthError).hint).toBe(`run: vibeterm login --node ${NODE}`);
  });

  test('via_mismatch is treated as an invalid session', async () => {
    const http = client(
      async () =>
        new Response(JSON.stringify({ error: 'via_mismatch' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
    );
    const error = (await http.json('self', 'GET', '/api/devices').catch((err) => err)) as AuthError;
    expect(error.code).toBe('via_mismatch');
    expect(error.hint).toBe('run: vibeterm login');
  });

  test('404 becomes a not-found error (exit 4)', async () => {
    const http = client(async () => new Response('{"error":"Not found"}', { status: 404 }));
    const error = await http.json('self', 'GET', '/api/nope').catch((err) => err);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).exitCode).toBe(4);
  });

  test('transport failures become network errors (exit 5)', async () => {
    const http = client(async () => {
      throw new TypeError('fetch failed');
    });
    const error = await http.json('self', 'GET', '/api/devices').catch((err) => err);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).exitCode).toBe(5);
  });

  test('ignores Set-Cookie sessions for any node other than self or the target', async () => {
    const jar = createMemoryCookieJar();
    const foreign = 'b'.repeat(32);
    jar.set(foreign, 'sid-foreign', 0);
    const headers = new Headers({ location: '/elsewhere' });
    // 一次重定向响应里塞进第三台 node 的会话 cookie：绝不能覆盖我们手上那把。
    headers.append('set-cookie', `vibeterm_s_${foreign}=stolen; Path=/; Max-Age=60`);
    headers.append('set-cookie', `vibeterm_s_${NODE}=sid-node; Path=/; Max-Age=60`);
    headers.append('set-cookie', 'vibeterm_s_self=sid-self; Path=/; Max-Age=60');
    const http = client(async () => new Response(null, { status: 302, headers }), jar);

    await http.fetch(NODE, '/api/devices');

    expect(jar.get(foreign)?.sid).toBe('sid-foreign');
    expect(jar.get(NODE)?.sid).toBe('sid-node');
    expect(jar.get('self')?.sid).toBe('sid-self');
  });

  test('ndjson yields one parsed object per line', async () => {
    const http = client(
      async () =>
        new Response('{"a":1}\n{"b":2}\n{"c":3}', {
          headers: { 'content-type': 'application/x-ndjson' },
        })
    );
    const rows: unknown[] = [];
    for await (const row of http.ndjson('self', '/api/transfer/jobs')) rows.push(row);
    expect(rows).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });
});
