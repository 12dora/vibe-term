import { describe, expect, test } from 'bun:test';
import { fetchMeshNodes, isNodeUnreachableError, listMeshNodes } from './auth';
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
});
