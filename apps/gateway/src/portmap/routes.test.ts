import { afterEach, describe, expect, test } from 'bun:test';
import type { ApiRoute } from '../api/route';
import { dispatchRoutes } from '../api/route';
import { PortMapManager } from './manager';
import { createPortMapRoutes } from './routes';
import { MemoryPortMapExportStore, MemoryPortMapStore } from './store';

const NODE = 'e'.repeat(32);

function freePort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

type Harness = {
  routes: ApiRoute[];
  manager: PortMapManager;
  exports: MemoryPortMapExportStore;
};

const managers: PortMapManager[] = [];

function harness(): Harness {
  const manager = new PortMapManager({
    store: new MemoryPortMapStore(),
    peers: () => null,
    reservedPorts: () => [19_663],
  });
  managers.push(manager);
  manager.start();
  const exports = new MemoryPortMapExportStore();
  return {
    manager,
    exports,
    routes: createPortMapRoutes({ manager: () => manager, exports: () => exports }),
  };
}

async function call(
  h: Harness,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = `http://node${path}`;
  const req = new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  const res = await dispatchRoutes(req, new URL(url).pathname, h.routes, { path });
  if (!res) throw new Error(`no route for ${method} ${path}`);
  const resolved = await res;
  return { status: resolved.status, json: (await resolved.json()) as Record<string, unknown> };
}

describe('portmap routes', () => {
  afterEach(() => {
    while (managers.length > 0) managers.pop()?.stop();
  });

  test('lists, creates, patches and deletes maps', async () => {
    const h = harness();
    expect((await call(h, 'GET', '/api/portmap')).json.maps as unknown[]).toEqual([]);
    const created = await call(h, 'POST', '/api/portmap', {
      name: 'pg',
      listenPort: freePort(),
      targetNodeId: NODE,
      targetPort: 5432,
      mapId: 'route-map-001',
    });
    expect(created.status).toBe(201);
    expect((created.json.map as { id: string }).id).toBe('route-map-001');
    const patched = await call(h, 'PATCH', '/api/portmap/route-map-001', { paused: true });
    expect((patched.json.map as { state: string }).state).toBe('paused');
    const removed = await call(h, 'DELETE', '/api/portmap/route-map-001');
    expect(removed.status).toBe(200);
    expect((await call(h, 'GET', '/api/portmap')).json.maps as unknown[]).toEqual([]);
  });

  test('reports conflicts and validation failures with a code', async () => {
    const h = harness();
    const port = freePort();
    await call(h, 'POST', '/api/portmap', {
      listenPort: port,
      targetNodeId: NODE,
      targetPort: 1,
    });
    const conflict = await call(h, 'POST', '/api/portmap', {
      listenPort: port,
      targetNodeId: NODE,
      targetPort: 1,
    });
    expect(conflict.status).toBe(409);
    expect((conflict.json.error as { code: string }).code).toBe('port_in_use');
    expect(conflict.json.code).toBe('port_in_use');
    const reserved = await call(h, 'POST', '/api/portmap', {
      listenPort: 19_663,
      targetNodeId: NODE,
      targetPort: 1,
    });
    expect((reserved.json.error as { code: string }).code).toBe('port_reserved');
    const invalid = await call(h, 'POST', '/api/portmap', {
      listenPort: 70_000,
      targetNodeId: NODE,
      targetPort: 1,
    });
    expect(invalid.status).toBe(400);
    expect((invalid.json.error as { code: string }).code).toBe('invalid_request');
    const missing = await call(h, 'PATCH', '/api/portmap/nope', { paused: true });
    expect(missing.status).toBe(404);
    expect((missing.json.error as { code: string }).code).toBe('not_found');
  });

  test('probes local ports', async () => {
    const h = harness();
    const port = freePort();
    const free = await call(h, 'GET', `/api/portmap/probe?host=127.0.0.1&port=${port}`);
    expect(free.json).toEqual({
      host: '127.0.0.1',
      port,
      free: true,
      reserved: false,
      usedByMapId: null,
    });
    const reserved = await call(h, 'GET', '/api/portmap/probe?port=19663');
    expect(reserved.json.reserved).toBe(true);
    expect(reserved.json.free).toBe(false);
    const bad = await call(h, 'GET', '/api/portmap/probe?port=abc');
    expect(bad.status).toBe(400);
  });

  test('creates, lists and deletes export rows', async () => {
    const h = harness();
    const created = await call(h, 'POST', '/api/portmap/exports', {
      mapId: 'route-map-002',
      fromNodeId: NODE,
      port: 5432,
    });
    expect(created.status).toBe(201);
    expect(created.json.export).toEqual({
      mapId: 'route-map-002',
      fromNodeId: NODE,
      host: '127.0.0.1',
      port: 5432,
      enabled: true,
      createdAt: expect.any(Number),
    });
    expect((await call(h, 'GET', '/api/portmap/exports')).json.exports as unknown[]).toHaveLength(
      1
    );
    const generated = await call(h, 'POST', '/api/portmap/exports', {
      fromNodeId: NODE,
      port: 5433,
    });
    expect((generated.json.export as { mapId: string }).mapId).toHaveLength(32);
    await call(h, 'DELETE', '/api/portmap/exports/route-map-002');
    expect((await call(h, 'GET', '/api/portmap/exports')).json.exports as unknown[]).toHaveLength(
      1
    );
    const invalid = await call(h, 'POST', '/api/portmap/exports', { fromNodeId: 'x', port: 1 });
    expect(invalid.status).toBe(400);
  });

  test('probes a target port on this node', async () => {
    const h = harness();
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    try {
      const res = await call(h, 'GET', `/api/portmap/target-probe?port=${server.port}`);
      expect(res.json).toEqual({ host: '127.0.0.1', port: server.port, listening: true });
    } finally {
      server.stop(true);
    }
  });
});
