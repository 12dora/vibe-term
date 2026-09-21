import { describe, expect, test } from 'bun:test';
import {
  type SessionMaterial,
  fetchMeshNodes,
  isNodeUnreachableError,
  isUnexpectedLoginCode,
  listMeshNodes,
  loginFailure,
  loginToNode,
  unexpectedLoginCode,
} from './auth';
import { AuthError, CliError, NetworkError, NotFoundError, PermissionError } from './errors';
import { HttpClient, createMemoryCookieJar } from './http';

const ENTRY = 'http://entry.example:9883';

function httpWith(status: number, body: unknown): HttpClient {
  return new HttpClient({
    entry: ENTRY,
    timeoutMs: 1000,
    jar: createMemoryCookieJar(),
    fetchImpl: async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  });
}

describe('isNodeUnreachableError', () => {
  test('NetworkError and NODE_UNREACHABLE CliError are unreachable', () => {
    expect(isNodeUnreachableError(new NetworkError('down'))).toBe(true);
    expect(isNodeUnreachableError(new CliError('offline', 1, undefined, 'NODE_UNREACHABLE'))).toBe(
      true
    );
    expect(isNodeUnreachableError(new CliError('nope', 1, undefined, 'INVALID_CREDENTIALS'))).toBe(
      false
    );
  });
});

describe('fetchMeshNodes', () => {
  test('401 is unauthorized (stale self cookie), not an empty roster', async () => {
    const http = httpWith(401, { error: 'UNAUTHORIZED' });
    expect(await fetchMeshNodes(http)).toEqual({ ok: false, unauthorized: true });
    expect(await listMeshNodes(http)).toEqual([]);
  });

  test('404 is an empty roster', async () => {
    const http = httpWith(404, { error: 'Not found' });
    expect(await fetchMeshNodes(http)).toEqual({ ok: true, nodes: [] });
  });

  test('200 returns the nodes list', async () => {
    const id = 'a'.repeat(32);
    const http = httpWith(200, { nodes: [{ id, name: 'office' }] });
    const result = await fetchMeshNodes(http);
    expect(result).toMatchObject({ ok: true, nodes: [{ id, name: 'office' }] });
  });

  test('403 via_mismatch is unauthorized like 401', async () => {
    const http = httpWith(403, { error: 'via_mismatch' });
    expect(await fetchMeshNodes(http)).toEqual({ ok: false, unauthorized: true });
  });

  test('403 expired / revoked / SESSION_* are unauthorized', async () => {
    expect(await fetchMeshNodes(httpWith(403, { code: 'expired' }))).toEqual({
      ok: false,
      unauthorized: true,
    });
    expect(await fetchMeshNodes(httpWith(403, { code: 'revoked' }))).toEqual({
      ok: false,
      unauthorized: true,
    });
    expect(await fetchMeshNodes(httpWith(403, { code: 'SESSION_REVOKED' }))).toEqual({
      ok: false,
      unauthorized: true,
    });
  });

  test('403 FORBIDDEN stays a network error', async () => {
    await expect(fetchMeshNodes(httpWith(403, { code: 'FORBIDDEN' }))).rejects.toBeInstanceOf(
      NetworkError
    );
  });
});

describe('loginToNode unreachable', () => {
  const dummy = {
    uid: 'u',
    entryNodeId: 'e'.repeat(32),
    sessPk: new Uint8Array(32),
    sessSk: new Uint8Array(64),
    delegationBytes: new Uint8Array(1),
    delegationSig: new Uint8Array(64),
    delegation: {} as SessionMaterial['delegation'],
    kTotp: null,
    destroy() {},
  } satisfies SessionMaterial;

  function httpThrowing(message: string): HttpClient {
    return new HttpClient({
      entry: ENTRY,
      timeoutMs: 1000,
      jar: createMemoryCookieJar(),
      fetchImpl: async () => {
        throw new Error(message);
      },
    });
  }

  test('entry NetworkError is rethrown with the original message', async () => {
    const error = await loginToNode({
      http: httpThrowing('ECONNRESET'),
      nodeId: 'self',
      material: dummy,
    }).catch((err) => err);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).exitCode).toBe(5);
    expect((error as NetworkError).message).toContain('ECONNRESET');
    expect((error as NetworkError).message).toContain('/api/auth/challenge');
  });

  test('treatUnreachableAsOutcome turns NetworkError into NODE_UNREACHABLE', async () => {
    const result = await loginToNode({
      http: httpThrowing('ECONNREFUSED'),
      nodeId: 'a'.repeat(32),
      material: dummy,
      treatUnreachableAsOutcome: true,
    });
    expect(result).toEqual({ nodeId: 'a'.repeat(32), ok: false, code: 'NODE_UNREACHABLE' });
  });

  function hangOnSignal(signal: AbortSignal | null | undefined): Promise<Response> {
    return new Promise((_resolve, reject) => {
      const fail = () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal?.aborted) {
        fail();
        return;
      }
      signal?.addEventListener('abort', fail, { once: true });
    });
  }

  test('an aborted signal becomes TIMEOUT and really cancels the in-flight fetch', async () => {
    let sawSignal: AbortSignal | undefined;
    const http = new HttpClient({
      entry: ENTRY,
      timeoutMs: 60_000,
      jar: createMemoryCookieJar(),
      fetchImpl: async (_url, init) => {
        sawSignal = init?.signal ?? undefined;
        return hangOnSignal(init?.signal);
      },
    });
    const signal = AbortSignal.timeout(30);
    const result = await loginToNode({
      http,
      nodeId: 'a'.repeat(32),
      material: dummy,
      treatUnreachableAsOutcome: true,
      signal,
      timeoutMs: 30,
    });
    expect(result).toEqual({ nodeId: 'a'.repeat(32), ok: false, code: 'TIMEOUT' });
    expect(sawSignal?.aborted).toBe(true);
  });

  test('entry timeout without treatUnreachableAsOutcome throws NetworkError', async () => {
    const http = new HttpClient({
      entry: ENTRY,
      timeoutMs: 60_000,
      jar: createMemoryCookieJar(),
      fetchImpl: async (_url, init) => hangOnSignal(init?.signal),
    });
    const error = await loginToNode({
      http,
      nodeId: 'self',
      material: dummy,
      signal: AbortSignal.timeout(30),
      timeoutMs: 30,
    }).catch((err) => err);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).exitCode).toBe(5);
    expect((error as NetworkError).message).toContain('timed out');
    expect((error as NetworkError).hint).toContain('--node-timeout');
  });
});

describe('unexpected login codes', () => {
  test('HTTP 500/404/403 from thrown CliError become HTTP_* outcome codes', () => {
    expect(
      unexpectedLoginCode(new CliError('/api/auth/challenge → HTTP 500 {"error":"boom"}'))
    ).toBe('HTTP_500');
    expect(unexpectedLoginCode(new NotFoundError('/api/auth/challenge → 404 not found'))).toBe(
      'HTTP_404'
    );
    expect(
      unexpectedLoginCode(new PermissionError('/api/auth/challenge → FORBIDDEN', 'FORBIDDEN'))
    ).toBe('HTTP_403');
    expect(unexpectedLoginCode(new Error('nope'))).toBe('HTTP_ERROR');
    expect(isUnexpectedLoginCode('HTTP_500')).toBe(true);
    expect(isUnexpectedLoginCode('HTTP_ERROR')).toBe(true);
    expect(isUnexpectedLoginCode('INVALID_CREDENTIALS')).toBe(false);
  });

  test('loginFailure maps HTTP_* to generic exit 1 and auth codes to 3', () => {
    const http = loginFailure('n1', 'HTTP_500');
    expect(http).toBeInstanceOf(CliError);
    expect(http).not.toBeInstanceOf(AuthError);
    expect(http.exitCode).toBe(1);
    const auth = loginFailure('n1', 'INVALID_CREDENTIALS');
    expect(auth).toBeInstanceOf(AuthError);
    expect(auth.exitCode).toBe(3);
  });
});
