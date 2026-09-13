import { describe, expect, test } from 'bun:test';
import {
  AuthError,
  CliError,
  NetworkError,
  NotFoundError,
  PermissionError,
  UsageError,
} from './errors';
import {
  type FileRootDto,
  MkdirUnsupportedError,
  RSYNC_MISSING_LOCAL_MESSAGE,
  isMissingRoute,
  mapFilesStatusError,
  mkdirRemote,
  resolveFileRoot,
  statRemote,
} from './files-api';
import { VIRTUAL_FS_ROOT_ID, VIRTUAL_HOME_ROOT_ID } from './files-path';
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

const HOME_VIRTUAL: FileRootDto = {
  id: VIRTUAL_HOME_ROOT_ID,
  deviceId: 'd-1',
  deviceName: 'laptop',
  deviceType: 'local',
  path: '/home/me',
  name: 'home',
  enabled: true,
  sortOrder: 0,
  virtual: true,
};

const USER_HOME: FileRootDto = {
  id: '11111111-1111-4111-8111-111111111111',
  deviceId: 'd-1',
  deviceName: 'laptop',
  deviceType: 'local',
  path: '/srv/home',
  name: 'home',
  enabled: true,
  sortOrder: 1,
};

describe('resolveFileRoot', () => {
  test('accepts virtual home by name and by id', () => {
    expect(resolveFileRoot([HOME_VIRTUAL], 'home').id).toBe(VIRTUAL_HOME_ROOT_ID);
    expect(resolveFileRoot([HOME_VIRTUAL], VIRTUAL_HOME_ROOT_ID).id).toBe(VIRTUAL_HOME_ROOT_ID);
  });

  test('user-created enabled home wins over virtual home-root', () => {
    expect(resolveFileRoot([HOME_VIRTUAL, USER_HOME], 'home')).toEqual(USER_HOME);
  });

  test('disabled user home does not shadow virtual home', () => {
    const disabled = { ...USER_HOME, enabled: false };
    expect(resolveFileRoot([HOME_VIRTUAL, disabled], 'home')).toEqual(HOME_VIRTUAL);
  });

  test('fs-root still synthesizes when no enabled roots', () => {
    expect(resolveFileRoot([disabledHome()], VIRTUAL_FS_ROOT_ID).id).toBe(VIRTUAL_FS_ROOT_ID);
  });

  test('fs-root still synthesizes when the only enabled root is virtual home', () => {
    expect(resolveFileRoot([HOME_VIRTUAL], VIRTUAL_FS_ROOT_ID).id).toBe(VIRTUAL_FS_ROOT_ID);
  });

  test('fs-root still synthesizes with virtual home plus a disabled user root', () => {
    expect(resolveFileRoot([HOME_VIRTUAL, disabledHome()], VIRTUAL_FS_ROOT_ID).id).toBe(
      VIRTUAL_FS_ROOT_ID
    );
  });

  test('fs-root is invalid once a user-enabled root exists', () => {
    expect(() => resolveFileRoot([HOME_VIRTUAL, USER_HOME], VIRTUAL_FS_ROOT_ID)).toThrow(
      UsageError
    );
  });

  test('home-root id falls back to the unique enabled user home when the virtual entry is omitted', () => {
    expect(resolveFileRoot([USER_HOME], VIRTUAL_HOME_ROOT_ID)).toEqual(USER_HOME);
  });

  test('home-root id does not fall back to a disabled user home', () => {
    expect(() => resolveFileRoot([{ ...USER_HOME, enabled: false }], VIRTUAL_HOME_ROOT_ID)).toThrow(
      NotFoundError
    );
  });
});

function disabledHome(): FileRootDto {
  return { ...USER_HOME, enabled: false, name: 'docs' };
}

describe('mapFilesStatusError', () => {
  test('rsync_missing_local is exit 5 with the agent hint', () => {
    const error = mapFilesStatusError(
      NODE,
      '/api/files/stat',
      502,
      JSON.stringify({ error: 'rsync missing', code: 'rsync_missing_local' })
    );
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.exitCode).toBe(5);
    expect(error.message).toBe(RSYNC_MISSING_LOCAL_MESSAGE);
  });

  test('statRemote maps 502 rsync_missing_local', async () => {
    const http = client(async () =>
      json({ error: '服务器上未安装 rsync', code: 'rsync_missing_local' }, 502)
    );
    const error = (await statRemote(http, NODE, 'r-1', '/home/me/a').catch(
      (err) => err
    )) as CliError;
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.exitCode).toBe(5);
    expect(error.message).toBe(RSYNC_MISSING_LOCAL_MESSAGE);
  });

  test('other 502 stay generic', () => {
    const error = mapFilesStatusError(
      NODE,
      '/api/files/stat',
      502,
      JSON.stringify({ code: 'boom' })
    );
    expect(error).not.toBeInstanceOf(NetworkError);
    expect(error.exitCode).toBe(1);
  });
});
