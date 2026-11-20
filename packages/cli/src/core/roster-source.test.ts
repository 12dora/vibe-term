import { describe, expect, test } from 'bun:test';
import type { MeshNode } from '@vibeterm/api-client/auth/types';
import { AuthError, NetworkError } from './errors';
import { HttpClient, createMemoryCookieJar } from './http';
import { fetchMeshNodes, fetchMeshRoster, listMeshNodes } from './roster-source';
import { POP_ERROR_MESSAGE_EN } from './session-pop';

const ENTRY = 'http://entry.example:9883';
const NODE_A = 'a'.repeat(32);
const NODE_B = 'b'.repeat(32);
const NODE_C = 'c'.repeat(32);
const NODE_D = 'd'.repeat(32);

function meshNode(partial: Partial<MeshNode> = {}): MeshNode {
  return {
    id: NODE_A,
    name: 'office',
    publicKey: 'pk',
    online: true,
    reach: 'lan',
    version: '2.10.0',
    direct_capable: true,
    loggedIn: true,
    ...partial,
  };
}

const OFFICE = meshNode();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function meshPath(url: string): string {
  return new URL(url).pathname;
}

function client(
  fetchImpl: (url: string) => Promise<Response> | Response,
  jar = createMemoryCookieJar()
): HttpClient {
  return new HttpClient({
    entry: ENTRY,
    timeoutMs: 1000,
    jar,
    fetchImpl: async (url) => fetchImpl(url),
  });
}

function liveJar(ids: readonly string[]): ReturnType<typeof createMemoryCookieJar> {
  const jar = createMemoryCookieJar();
  const exp = Date.now() + 60_000;
  for (const id of ids) jar.set(id, `sid-${id.slice(0, 4)}`, exp);
  return jar;
}

describe('fetchMeshRoster', () => {
  test('self 200 is used as-is and does not probe other nodes', async () => {
    const seen: string[] = [];
    const http = client(
      async (url) => {
        seen.push(meshPath(url));
        return json({ nodes: [OFFICE], pendingMemberIds: ['pend'] });
      },
      liveJar([NODE_A])
    );
    expect(await fetchMeshRoster(http)).toEqual({
      nodes: [OFFICE],
      pendingMemberIds: ['pend'],
      source: 'self',
    });
    expect(seen).toEqual(['/api/mesh/nodes']);
  });

  test('self 404 is an empty roster', async () => {
    const http = client(async () => json({ error: 'Not found' }, 404));
    expect(await fetchMeshRoster(http)).toEqual({
      nodes: [],
      pendingMemberIds: [],
      source: 'self',
    });
  });

  test('self 401 falls back to a live node', async () => {
    const seen: string[] = [];
    const http = client(
      async (url) => {
        seen.push(meshPath(url));
        if (meshPath(url) === '/api/mesh/nodes') return json({ error: 'UNAUTHORIZED' }, 401);
        return json({ nodes: [OFFICE] });
      },
      liveJar([NODE_A])
    );
    expect(await fetchMeshRoster(http)).toEqual({
      nodes: [OFFICE],
      pendingMemberIds: [],
      source: NODE_A,
    });
    expect(seen).toEqual(['/api/mesh/nodes', `/n/${NODE_A}/api/mesh/nodes`]);
  });

  test('self session-type 403 also falls back', async () => {
    const http = client(
      async (url) => {
        if (meshPath(url) === '/api/mesh/nodes') return json({ error: 'via_mismatch' }, 403);
        return json({ nodes: [OFFICE] });
      },
      liveJar([NODE_A])
    );
    expect((await fetchMeshRoster(http)).nodes).toEqual([OFFICE]);
  });

  test('network errors on a fallback node move on to the next', async () => {
    const http = client(
      async (url) => {
        const path = meshPath(url);
        if (path === '/api/mesh/nodes') return json({ error: 'UNAUTHORIZED' }, 401);
        if (path === `/n/${NODE_A}/api/mesh/nodes`) throw new Error('offline');
        return json({ nodes: [OFFICE] });
      },
      liveJar([NODE_A, NODE_B])
    );
    expect((await fetchMeshRoster(http)).nodes).toEqual([OFFICE]);
  });

  test('all fallbacks failing rethrows the original self error', async () => {
    const http = client(async () => json({ error: 'UNAUTHORIZED' }, 401), liveJar([NODE_A]));
    const error = (await fetchMeshRoster(http).catch((err) => err)) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.exitCode).toBe(3);
    expect(error.message).toBe(`this command runs on the entry ${ENTRY}, which has no session`);
    expect(error.hint).toBe(
      'run: vibeterm login, or redeem a login command that includes the entry'
    );
    expect(error.code).toBe('UNAUTHORIZED');
  });

  test('PoP on self is not treated as logged out and is not swallowed', async () => {
    let probed = false;
    const http = client(
      async (url) => {
        if (meshPath(url).startsWith('/n/')) probed = true;
        return json({ code: 'POP_REQUIRED' }, 401);
      },
      liveJar([NODE_A])
    );
    const error = (await fetchMeshRoster(http).catch((err) => err)) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.code).toBe('POP_REQUIRED');
    expect(error.message).toBe(POP_ERROR_MESSAGE_EN);
    expect(probed).toBe(false);
  });

  test('fallback is bounded to three live nodes', async () => {
    const seen: string[] = [];
    const http = client(
      async (url) => {
        seen.push(meshPath(url));
        return json({ error: 'UNAUTHORIZED' }, 401);
      },
      liveJar([NODE_A, NODE_B, NODE_C, NODE_D])
    );
    await fetchMeshRoster(http).catch(() => undefined);
    expect(seen).toEqual([
      '/api/mesh/nodes',
      `/n/${NODE_A}/api/mesh/nodes`,
      `/n/${NODE_B}/api/mesh/nodes`,
      `/n/${NODE_C}/api/mesh/nodes`,
    ]);
  });

  test('self in the jar is not used as a fallback target', async () => {
    const seen: string[] = [];
    const http = client(
      async (url) => {
        seen.push(meshPath(url));
        return json({ error: 'UNAUTHORIZED' }, 401);
      },
      liveJar(['self', NODE_A])
    );
    await fetchMeshRoster(http).catch(() => undefined);
    expect(seen).toEqual(['/api/mesh/nodes']);
  });

  test('an expired self row does not fall back', async () => {
    const seen: string[] = [];
    const jar = createMemoryCookieJar();
    jar.set('self', 'sid-old', Date.now() - 1000);
    jar.set(NODE_A, 'sid-a', Date.now() + 60_000);
    const http = client(async (url) => {
      seen.push(meshPath(url));
      return json({ error: 'expired' }, 401);
    }, jar);
    const error = (await fetchMeshRoster(http).catch((err) => err)) as AuthError;
    expect(error.message).toBe('not authenticated for node self (expired)');
    expect(error.code).toBe('expired');
    expect(seen).toEqual(['/api/mesh/nodes']);
  });

  test('a stored self token does not fall back', async () => {
    const seen: string[] = [];
    const jar = liveJar([NODE_A]);
    const http = new HttpClient({
      entry: ENTRY,
      timeoutMs: 1000,
      jar,
      tokens: { get: (id) => (id === 'self' ? { secret: 'vtk_self' } : null) },
      fetchImpl: async (url) => {
        seen.push(meshPath(url));
        return json({ error: 'UNAUTHORIZED' }, 401);
      },
    });
    const error = (await fetchMeshRoster(http).catch((err) => err)) as AuthError;
    expect(error.message).toBe('not authenticated for node self (UNAUTHORIZED)');
    expect(seen).toEqual(['/api/mesh/nodes']);
  });
});

describe('fetchMeshNodes', () => {
  test('self 401 without a live peer is unauthorized, not thrown', async () => {
    const http = client(async () => json({ error: 'UNAUTHORIZED' }, 401));
    expect(await fetchMeshNodes(http)).toEqual({ ok: false, unauthorized: true });
    expect(await listMeshNodes(http)).toEqual([]);
  });

  test('self 401 with a live peer returns that roster', async () => {
    const http = client(
      async (url) => {
        if (meshPath(url) === '/api/mesh/nodes') return json({ error: 'UNAUTHORIZED' }, 401);
        return json({ nodes: [OFFICE] });
      },
      liveJar([NODE_A])
    );
    expect(await fetchMeshNodes(http)).toEqual({
      ok: true,
      nodes: [OFFICE],
      source: NODE_A,
    });
  });

  test('non-auth failures stay network errors', async () => {
    const http = client(async () => json({ code: 'FORBIDDEN' }, 403));
    await expect(fetchMeshNodes(http)).rejects.toBeInstanceOf(NetworkError);
  });
});
