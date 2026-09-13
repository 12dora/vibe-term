import { describe, expect, test } from 'bun:test';
import {
  type SessionMaterial,
  fetchMeshNodes,
  isNodeUnreachableError,
  listMeshNodes,
  loginToNode,
} from './auth';
import { CliError, NetworkError } from './errors';
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
});
