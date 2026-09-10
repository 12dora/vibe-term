import { describe, expect, test } from 'bun:test';
import { AuthError, CliError, PermissionError } from './errors';
import { MkdirUnsupportedError, isMissingRoute, mkdirRemote } from './files-api';
import { type FetchLike, HttpClient, createMemoryCookieJar } from './http';

const ENTRY = 'http://entry.example:9883';
const NODE = 'a'.repeat(32);

function client(fetchImpl: FetchLike): HttpClient {
  return new HttpClient({
    entry: ENTRY,
    timeoutMs: 1000,
    jar: createMemoryCookieJar(),
    fetchImpl,
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('isMissingRoute', () => {
  test('matches the gateway stable code first', () => {
    expect(isMissingRoute(404, JSON.stringify({ error: '未找到', code: 'route_not_found' }))).toBe(
      true
    );
  });

  test('falls back to the English text of older nodes', () => {
    expect(isMissingRoute(404, JSON.stringify({ error: 'Not found' }))).toBe(true);
    expect(isMissingRoute(404, JSON.stringify({ error: 'Not Found' }))).toBe(true);
    expect(isMissingRoute(404, 'Not Found')).toBe(true);
  });

  test('business not_found is a missing parent directory, not a missing route', () => {
    expect(isMissingRoute(404, JSON.stringify({ error: 'not_found', code: 'not_found' }))).toBe(
      false
    );
    expect(isMissingRoute(404, JSON.stringify({ code: 'root_not_found' }))).toBe(false);
  });

  test('only 404 counts', () => {
    expect(isMissingRoute(403, JSON.stringify({ code: 'route_not_found' }))).toBe(false);
  });
});

describe('mkdirRemote', () => {
  test('posts the api-client request body to the node-prefixed mkdir route', async () => {
    const seen: { url: string; body: string }[] = [];
    const http = client(async (url, init) => {
      seen.push({ url, body: String(init?.body ?? '') });
      return json({ path: '/home/me/sub', created: true }, 200);
    });
    const result = await mkdirRemote(http, NODE, {
      rootId: 'r-1',
      path: '/home/me/sub',
      recursive: true,
    });
    expect(result).toEqual({ path: '/home/me/sub', created: true });
    expect(seen[0].url).toBe(`${ENTRY}/n/${NODE}/api/files/mkdir`);
    expect(JSON.parse(seen[0].body)).toEqual({
      rootId: 'r-1',
      path: '/home/me/sub',
      recursive: true,
    });
  });

  test('route_not_found marks the node as too old', async () => {
    const http = client(async () => json({ error: '未找到', code: 'route_not_found' }, 404));
    const error = await mkdirRemote(http, NODE, { rootId: 'r-1', path: '/a' }).catch((err) => err);
    expect(error).toBeInstanceOf(MkdirUnsupportedError);
    expect((error as CliError).exitCode).toBe(1);
  });

  test('business not_found stays a plain not-found error', async () => {
    const http = client(async () => json({ error: 'not_found', code: 'not_found' }, 404));
    const error = (await mkdirRemote(http, NODE, { rootId: 'r-1', path: '/a' }).catch(
      (err) => err
    )) as CliError;
    expect(error).not.toBeInstanceOf(MkdirUnsupportedError);
    expect(error.exitCode).toBe(4);
  });

  test('403 permission_denied is exit 1 with the server code', async () => {
    const http = client(async () =>
      json({ error: 'permission_denied', code: 'permission_denied' }, 403)
    );
    const error = (await mkdirRemote(http, NODE, { rootId: 'r-1', path: '/a' }).catch(
      (err) => err
    )) as PermissionError;
    expect(error).toBeInstanceOf(PermissionError);
    expect(error.exitCode).toBe(1);
    expect(error.code).toBe('permission_denied');
  });

  test('401 still asks for a login', async () => {
    const http = client(async () => json({ error: 'NODE_LOGIN_REQUIRED' }, 401));
    const error = (await mkdirRemote(http, NODE, { rootId: 'r-1', path: '/a' }).catch(
      (err) => err
    )) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.exitCode).toBe(3);
  });

  test('aborts through the injected signal', async () => {
    const controller = new AbortController();
    const http = client(async (_url, init) => {
      expect(init?.signal).toBeDefined();
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const error = await mkdirRemote(
      http,
      NODE,
      { rootId: 'r-1', path: '/a' },
      controller.signal
    ).catch((err) => err);
    expect(error).toBeInstanceOf(CliError);
  });
});
