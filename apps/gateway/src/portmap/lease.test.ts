import { afterEach, describe, expect, test } from 'bun:test';
import { PORT_MAP_LEASE_DEFAULT_MS } from '@vibeterm/shared';
import { dispatchRoutes } from '../api/route';
import { startExportLeaseSweeper, sweepExpiredExports } from './export-lease';
import { PortMapManager } from './manager';
import { isPortFree } from './port-probe';
import { createPortMapRoutes } from './routes';
import { MemoryPortMapExportStore, MemoryPortMapStore } from './store';
import { PortMapError, type PortMapRow } from './types';

const TARGET = 'c'.repeat(32);
const NOW = 1_000_000;

function freePort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

function row(id: string, listenPort: number, patch: Partial<PortMapRow> = {}): PortMapRow {
  return {
    id,
    name: id,
    listenHost: '127.0.0.1',
    listenPort,
    targetNodeId: TARGET,
    targetHost: '127.0.0.1',
    targetPort: 22,
    paused: false,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

const managers: PortMapManager[] = [];
const stoppers: Array<() => void> = [];

function fixture(store = new MemoryPortMapStore(), sweepIntervalMs?: number) {
  const clock = { now: NOW };
  const cleanups: Array<{ nodeId: string; mapId: string }> = [];
  const manager = new PortMapManager({
    store,
    peers: () => null,
    reservedPorts: () => [19_663],
    now: () => clock.now,
    removePeerExport: async (nodeId, mapId) => {
      cleanups.push({ nodeId, mapId });
      return true;
    },
    ...(sweepIntervalMs === undefined ? {} : { sweepIntervalMs }),
  });
  managers.push(manager);
  return { clock, cleanups, manager, store };
}

function create(manager: PortMapManager, patch: { leaseMs?: number; port?: number } = {}) {
  return manager.create({
    listenPort: patch.port ?? freePort(),
    targetNodeId: TARGET,
    targetPort: 22,
    ...(patch.leaseMs === undefined ? {} : { leaseMs: patch.leaseMs }),
  });
}

afterEach(() => {
  while (managers.length > 0) managers.pop()?.stop();
  while (stoppers.length > 0) stoppers.pop()?.();
});

describe('portmap manager leases', () => {
  test('create stamps leaseExpiresAt and validates the range', () => {
    const { manager } = fixture();
    manager.start();
    expect(create(manager, { leaseMs: 90_000 }).leaseExpiresAt).toBe(NOW + 90_000);
    expect(create(manager).leaseExpiresAt).toBeUndefined();
    for (const bad of [29_999, 600_001, 1.5, Number.NaN]) {
      expect(() => create(manager, { leaseMs: bad })).toThrow(PortMapError);
    }
  });

  test('renew by leaseMs, by renewLease, and renewLease never leases a persistent map', () => {
    const { clock, manager } = fixture();
    manager.start();
    const leased = create(manager, { leaseMs: 60_000 });
    const plain = create(manager);
    clock.now = NOW + 50_000;
    expect(manager.update(leased.id, { leaseMs: 120_000 }).leaseExpiresAt).toBe(NOW + 170_000);
    expect(manager.update(leased.id, { renewLease: true }).leaseExpiresAt).toBe(
      NOW + 50_000 + PORT_MAP_LEASE_DEFAULT_MS
    );
    expect(manager.update(plain.id, { renewLease: true }).leaseExpiresAt).toBeUndefined();
    expect(manager.update(plain.id, { leaseMs: 30_000 }).leaseExpiresAt).toBe(NOW + 80_000);
    expect(() => manager.update(leased.id, { leaseMs: 10 })).toThrow(PortMapError);
  });

  test('sweeps expired maps: listener stopped, row deleted, peer export cleaned', () => {
    const { clock, cleanups, manager, store } = fixture();
    manager.start();
    const port = freePort();
    const leased = create(manager, { leaseMs: 30_000, port });
    const kept = create(manager);
    expect(isPortFree('127.0.0.1', port)).toBe(false);

    clock.now = NOW + 29_999;
    expect(manager.sweepExpired()).toEqual([]);
    clock.now = NOW + 30_000;
    expect(manager.sweepExpired()).toEqual([leased.id]);
    expect(isPortFree('127.0.0.1', port)).toBe(true);
    expect(store.get(leased.id)).toBeNull();
    expect(store.get(kept.id)).not.toBeNull();
    expect(cleanups).toEqual([{ nodeId: TARGET, mapId: leased.id }]);
    expect(manager.list().map((map) => map.id)).toEqual([kept.id]);
  });

  test('an expired map is gone for get/update even before the timer fires', () => {
    const { clock, manager } = fixture();
    manager.start();
    const map = create(manager, { leaseMs: 30_000 });
    clock.now = NOW + 31_000;
    expect(() => manager.update(map.id, { renewLease: true })).toThrow(PortMapError);
    expect(() => manager.get(map.id)).toThrow(PortMapError);
  });

  test('the periodic sweeper reaps without any API access', async () => {
    const { clock, manager, store } = fixture(new MemoryPortMapStore(), 5);
    manager.start();
    const map = create(manager, { leaseMs: 30_000 });
    clock.now = NOW + 60_000;
    for (let i = 0; i < 100 && store.get(map.id); i += 1) await Bun.sleep(5);
    expect(store.get(map.id)).toBeNull();
  });

  test('start() removes expired rows instead of restoring their listeners', () => {
    const store = new MemoryPortMapStore();
    const expiredPort = freePort();
    const livePort = freePort();
    store.insert(row('expired0001', expiredPort, { leaseExpiresAt: NOW - 1 }));
    store.insert(row('live00000001', livePort, { leaseExpiresAt: NOW + 60_000 }));
    store.insert(row('persist0001', freePort()));
    const { cleanups, manager } = fixture(store);
    manager.start();
    expect(store.get('expired0001')).toBeNull();
    expect(isPortFree('127.0.0.1', expiredPort)).toBe(true);
    expect(isPortFree('127.0.0.1', livePort)).toBe(false);
    expect(
      manager
        .list()
        .map((map) => map.id)
        .sort()
    ).toEqual(['live00000001', 'persist0001']);
    expect(cleanups).toEqual([{ nodeId: TARGET, mapId: 'expired0001' }]);
  });
});

type ExportBody = {
  export: { mapId: string; leaseExpiresAt?: number };
  exports: Array<{ mapId: string }>;
};

describe('export leases', () => {
  const exportRow = (mapId: string, leaseExpiresAt?: number) => ({
    mapId,
    fromNodeId: TARGET,
    host: '127.0.0.1',
    port: 22,
    enabled: true,
    createdAt: 1,
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
  });

  test('sweepExpiredExports deletes only expired leased rows', () => {
    const store = new MemoryPortMapExportStore();
    store.insert(exportRow('gone00000001', NOW - 1));
    store.insert(exportRow('gone00000002', NOW));
    store.insert(exportRow('live00000001', NOW + 1));
    store.insert(exportRow('plain0000001'));
    expect(sweepExpiredExports(store, NOW).sort()).toEqual(['gone00000001', 'gone00000002']);
    expect(
      store
        .list()
        .map((entry) => entry.mapId)
        .sort()
    ).toEqual(['live00000001', 'plain0000001']);
  });

  test('the sweeper starts with an immediate sweep and keeps running', async () => {
    const store = new MemoryPortMapExportStore();
    const clock = { now: NOW };
    store.insert(exportRow('gone00000001', NOW - 1));
    store.insert(exportRow('later0000001', NOW + 1_000));
    stoppers.push(startExportLeaseSweeper(() => store, { intervalMs: 5, now: () => clock.now }));
    expect(store.get('gone00000001')).toBeNull();
    clock.now = NOW + 2_000;
    for (let i = 0; i < 100 && store.get('later0000001'); i += 1) await Bun.sleep(5);
    expect(store.get('later0000001')).toBeNull();
  });

  test('routes create, renew, hide and drop leased exports', async () => {
    const exports = new MemoryPortMapExportStore();
    const clock = { now: NOW };
    const routes = createPortMapRoutes({
      manager: () => fixture().manager,
      exports: () => exports,
      removePeerExport: async () => true,
      now: () => clock.now,
    });
    const call = async (method: string, path: string, body?: unknown) => {
      const url = `http://node${path}`;
      const req = new Request(url, {
        method,
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      });
      const res = await dispatchRoutes(req, new URL(url).pathname, routes, { path });
      if (!res) throw new Error(`no route for ${method} ${path}`);
      const resolved = await res;
      return { status: resolved.status, json: (await resolved.json()) as ExportBody };
    };

    const created = await call('POST', '/api/portmap/exports', {
      fromNodeId: TARGET,
      port: 22,
      leaseMs: 90_000,
    });
    expect(created.json.export.leaseExpiresAt).toBe(NOW + 90_000);
    const mapId = created.json.export.mapId;
    expect(
      (await call('POST', '/api/portmap/exports', { fromNodeId: TARGET, port: 1 })).status
    ).toBe(201);
    expect(
      (await call('POST', '/api/portmap/exports', { fromNodeId: TARGET, port: 1, leaseMs: 5 }))
        .status
    ).toBe(400);

    clock.now = NOW + 60_000;
    const renewed = await call('PATCH', `/api/portmap/exports/${mapId}`, { leaseMs: 90_000 });
    expect(renewed.json.export.leaseExpiresAt).toBe(NOW + 150_000);
    const byFlag = await call('PATCH', `/api/portmap/exports/${mapId}`, { renewLease: true });
    expect(byFlag.json.export.leaseExpiresAt).toBe(NOW + 60_000 + PORT_MAP_LEASE_DEFAULT_MS);
    expect((await call('PATCH', `/api/portmap/exports/${mapId}`, { renewLease: 'x' })).status).toBe(
      400
    );

    clock.now = NOW + 400_000;
    const listed = await call('GET', '/api/portmap/exports');
    expect(listed.json.exports.map((entry) => entry.mapId)).not.toContain(mapId);
    const late = await call('PATCH', `/api/portmap/exports/${mapId}`, { renewLease: true });
    expect(late.status).toBe(404);
    expect(exports.get(mapId)).toBeNull();
  });
});

describe('map routes with leases', () => {
  test('POST accepts leaseMs and PATCH renews it', async () => {
    const { clock, manager } = fixture();
    manager.start();
    const routes = createPortMapRoutes({
      manager: () => manager,
      exports: () => new MemoryPortMapExportStore(),
      removePeerExport: async () => true,
    });
    const call = async (method: string, path: string, body: unknown) => {
      const url = `http://node${path}`;
      const req = new Request(url, {
        method,
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
      const res = await dispatchRoutes(req, new URL(url).pathname, routes, { path });
      if (!res) throw new Error(`no route for ${method} ${path}`);
      const resolved = await res;
      return {
        status: resolved.status,
        json: (await resolved.json()) as { map: { id: string; leaseExpiresAt?: number } },
      };
    };
    const body = { listenPort: freePort(), targetNodeId: TARGET, targetPort: 22 };
    const created = await call('POST', '/api/portmap', { ...body, leaseMs: 90_000 });
    expect(created.status).toBe(201);
    expect(created.json.map.leaseExpiresAt).toBe(NOW + 90_000);
    const id = created.json.map.id;

    clock.now = NOW + 30_000;
    const renewed = await call('PATCH', `/api/portmap/${id}`, { leaseMs: 90_000 });
    expect(renewed.json.map.leaseExpiresAt).toBe(NOW + 120_000);
    const flagged = await call('PATCH', `/api/portmap/${id}`, { renewLease: true });
    expect(flagged.json.map.leaseExpiresAt).toBe(NOW + 30_000 + PORT_MAP_LEASE_DEFAULT_MS);
    expect((await call('PATCH', `/api/portmap/${id}`, { leaseMs: 1 })).status).toBe(400);
    expect((await call('POST', '/api/portmap', { ...body, leaseMs: 1 })).status).toBe(400);
  });
});
