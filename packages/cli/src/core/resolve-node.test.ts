import { describe, expect, test } from 'bun:test';
import { HttpClient, createMemoryCookieJar } from './http';
import { Resolver } from './resolve';

const ENTRY = 'http://entry.example:9883';
const ENTRY_NODE_ID = 'e'.repeat(32);
const NODE_A = 'a'.repeat(32);

function resolver(routes: {
  mode?: unknown;
  nodes?: unknown;
  onFetch?: (url: string) => void;
}): Resolver {
  const http = new HttpClient({
    entry: ENTRY,
    timeoutMs: 1000,
    jar: createMemoryCookieJar(),
    fetchImpl: async (url) => {
      routes.onFetch?.(url);
      if (url.endsWith('/api/auth/mode')) {
        return routes.mode === undefined
          ? new Response('{"error":"Not found"}', { status: 404 })
          : Response.json(routes.mode);
      }
      if (url.endsWith('/api/mesh/nodes')) {
        return routes.nodes === undefined
          ? new Response('{"error":"Not found"}', { status: 404 })
          : Response.json(routes.nodes);
      }
      return new Response('{"error":"Not found"}', { status: 404 });
    },
  });
  return new Resolver(http);
}

const roster = {
  nodes: [
    { id: ENTRY_NODE_ID, name: 'hq', publicKey: 'pk-entry', online: true },
    { id: NODE_A, name: 'office', publicKey: 'pk-a', online: true },
  ],
};

describe('Resolver.resolveNode', () => {
  test('the entry’s own node id resolves to self, not /n/<hex>/', async () => {
    const target = resolver({ mode: { nodeId: ENTRY_NODE_ID }, nodes: roster });
    const resolved = await target.resolveNode(ENTRY_NODE_ID);
    expect(resolved.id).toBe('self');
    expect(resolved.isSelf).toBe(true);
    expect(resolved.name).toBe('hq');
  });

  test('the entry’s own name resolves to self too', async () => {
    const target = resolver({ mode: { nodeId: ENTRY_NODE_ID }, nodes: roster });
    const resolved = await target.resolveNode('hq');
    expect(resolved.id).toBe('self');
    expect(resolved.isSelf).toBe(true);
  });

  test('another node keeps its id', async () => {
    const target = resolver({ mode: { nodeId: ENTRY_NODE_ID }, nodes: roster });
    const resolved = await target.resolveNode(NODE_A);
    expect(resolved.id).toBe(NODE_A);
    expect(resolved.isSelf).toBe(false);
  });

  test('the entry node id is fetched at most once per process', async () => {
    const urls: string[] = [];
    const target = resolver({
      mode: { nodeId: ENTRY_NODE_ID },
      nodes: roster,
      onFetch: (url) => urls.push(url),
    });
    await target.resolveNode(NODE_A);
    await target.resolveNode(ENTRY_NODE_ID);
    expect(urls.filter((url) => url.endsWith('/api/auth/mode'))).toHaveLength(1);
  });

  test('an entry with no /api/auth/mode (standalone) leaves ids alone', async () => {
    const target = resolver({ nodes: roster });
    expect((await target.resolveNode(ENTRY_NODE_ID)).id).toBe(ENTRY_NODE_ID);
  });

  test('self aliases never hit the network', async () => {
    const urls: string[] = [];
    const target = resolver({ onFetch: (url) => urls.push(url) });
    for (const alias of ['', 'self', 'local', 'entry', '.']) {
      expect((await target.resolveNode(alias)).id).toBe('self');
    }
    expect(urls).toHaveLength(0);
  });
});
