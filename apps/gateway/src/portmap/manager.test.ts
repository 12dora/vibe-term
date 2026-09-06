import { afterEach, describe, expect, test } from 'bun:test';
import type { LinkSession } from '@vibeterm/shared/link';
import { resetPeerStreamSlots } from './budget';
import { PortMapManager } from './manager';
import { isPortFree } from './port-probe';
import { MemoryPortMapStore } from './store';
import { PortMapError, type PortMapPeers, type PortMapRow } from './types';

const TARGET_NODE = 'c'.repeat(32);

function freePort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

const hangingPeers: PortMapPeers = {
  getLink: () => new Promise<LinkSession>(() => {}),
};

function row(id: string, listenPort: number, patch: Partial<PortMapRow> = {}): PortMapRow {
  return {
    id,
    name: id,
    listenHost: '127.0.0.1',
    listenPort,
    targetNodeId: TARGET_NODE,
    targetHost: '127.0.0.1',
    targetPort: 22,
    paused: false,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

const managers: PortMapManager[] = [];

function newManager(store: MemoryPortMapStore, peers: PortMapPeers | null = null): PortMapManager {
  const manager = new PortMapManager({
    store,
    peers: () => peers,
    reservedPorts: () => [19_663, 19_883],
  });
  managers.push(manager);
  return manager;
}

describe('portmap manager', () => {
  afterEach(() => {
    while (managers.length > 0) managers.pop()?.stop();
    resetPeerStreamSlots();
  });

  test('creates a listening map and reports it', () => {
    const manager = newManager(new MemoryPortMapStore());
    manager.start();
    const port = freePort();
    const dto = manager.create({
      name: 'db',
      listenPort: port,
      targetNodeId: TARGET_NODE,
      targetPort: 5432,
    });
    expect(dto.state).toBe('listening');
    expect(dto.listenHost).toBe('127.0.0.1');
    expect(dto.targetHost).toBe('127.0.0.1');
    expect(isPortFree('127.0.0.1', port)).toBe(false);
    expect(manager.list()).toHaveLength(1);
    expect(manager.probe('127.0.0.1', port).usedByMapId).toBe(dto.id);
  });

  test('keeps the caller supplied map id so it matches the export row', () => {
    const manager = newManager(new MemoryPortMapStore());
    manager.start();
    const dto = manager.create({
      listenPort: freePort(),
      targetNodeId: TARGET_NODE,
      targetPort: 5432,
      mapId: 'shared-map-id-1',
    });
    expect(dto.id).toBe('shared-map-id-1');
  });

  test('refuses an occupied, duplicated or reserved port', () => {
    const manager = newManager(new MemoryPortMapStore());
    manager.start();
    const port = freePort();
    manager.create({ listenPort: port, targetNodeId: TARGET_NODE, targetPort: 1 });
    expect(() =>
      manager.create({ listenPort: port, targetNodeId: TARGET_NODE, targetPort: 1 })
    ).toThrow(PortMapError);
    expect(() =>
      manager.create({ listenPort: 19_663, targetNodeId: TARGET_NODE, targetPort: 1 })
    ).toThrow(/reserved|VibeTerm itself/);
    const occupied = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    try {
      expect(() =>
        manager.create({ listenPort: occupied.port, targetNodeId: TARGET_NODE, targetPort: 1 })
      ).toThrow(/occupied/);
    } finally {
      occupied.stop(true);
    }
  });

  test('rejects invalid input', () => {
    const manager = newManager(new MemoryPortMapStore());
    manager.start();
    expect(() =>
      manager.create({ listenPort: 0, targetNodeId: TARGET_NODE, targetPort: 1 })
    ).toThrow(PortMapError);
    expect(() => manager.create({ listenPort: 1, targetNodeId: 'nope', targetPort: 1 })).toThrow(
      PortMapError
    );
  });

  test('pause frees the port and resume takes it back', () => {
    const manager = newManager(new MemoryPortMapStore());
    manager.start();
    const port = freePort();
    const dto = manager.create({ listenPort: port, targetNodeId: TARGET_NODE, targetPort: 1 });
    expect(manager.update(dto.id, { paused: true }).state).toBe('paused');
    expect(isPortFree('127.0.0.1', port)).toBe(true);
    expect(manager.update(dto.id, { paused: false, name: 'again' }).state).toBe('listening');
    expect(manager.get(dto.id).name).toBe('again');
    expect(isPortFree('127.0.0.1', port)).toBe(false);
  });

  test('resuming an already listening map is a no-op', () => {
    const manager = newManager(new MemoryPortMapStore());
    manager.start();
    const dto = manager.create({
      listenPort: freePort(),
      targetNodeId: TARGET_NODE,
      targetPort: 1,
    });
    expect(manager.update(dto.id, { paused: false }).state).toBe('listening');
  });

  test('delete stops the listener and frees the port', () => {
    const store = new MemoryPortMapStore();
    const manager = newManager(store);
    manager.start();
    const port = freePort();
    const dto = manager.create({ listenPort: port, targetNodeId: TARGET_NODE, targetPort: 1 });
    manager.remove(dto.id);
    expect(manager.list()).toHaveLength(0);
    expect(store.list()).toHaveLength(0);
    expect(isPortFree('127.0.0.1', port)).toBe(true);
    expect(() => manager.remove(dto.id)).toThrow(PortMapError);
  });

  test('boot resume skips paused rows and marks occupied ports as error', () => {
    const store = new MemoryPortMapStore();
    const freeOne = freePort();
    const occupied = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    store.insert(row('live', freeOne));
    store.insert(row('sleeping', freePort(), { paused: true }));
    store.insert(row('taken', occupied.port));
    const manager = newManager(store);
    try {
      manager.start();
      const byId = new Map(manager.list().map((dto) => [dto.id, dto]));
      expect(byId.get('live')?.state).toBe('listening');
      expect(byId.get('sleeping')?.state).toBe('paused');
      expect(byId.get('taken')?.state).toBe('error');
      expect(byId.get('taken')?.error).toBe('port_in_use');
    } finally {
      occupied.stop(true);
    }
  });

  test('counts connections and refuses beyond the per-map cap', async () => {
    const manager = new PortMapManager({
      store: new MemoryPortMapStore(),
      peers: () => hangingPeers,
      reservedPorts: () => [],
      maxConnections: 1,
    });
    managers.push(manager);
    manager.start();
    const port = freePort();
    const dto = manager.create({ listenPort: port, targetNodeId: TARGET_NODE, targetPort: 1 });
    const first = await Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: { data() {}, close() {} },
    });
    await Bun.sleep(30);
    expect(manager.get(dto.id).activeConnections).toBe(1);
    let secondClosed = false;
    const second = await Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        data() {},
        close() {
          secondClosed = true;
        },
      },
    });
    await Bun.sleep(50);
    expect(secondClosed).toBe(true);
    expect(manager.get(dto.id).totalConnections).toBe(1);
    first.terminate();
    second.terminate();
    await Bun.sleep(30);
    expect(manager.get(dto.id).activeConnections).toBe(0);
  });

  test('closes the local socket when mesh is not available', async () => {
    const manager = newManager(new MemoryPortMapStore());
    manager.start();
    const port = freePort();
    manager.create({ listenPort: port, targetNodeId: TARGET_NODE, targetPort: 1 });
    let closed = false;
    const socket = await Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        data() {},
        close() {
          closed = true;
        },
      },
    });
    await Bun.sleep(50);
    expect(closed).toBe(true);
    socket.terminate();
  });

  test('a failed resume keeps the row paused and a later retry still binds', () => {
    const store = new MemoryPortMapStore();
    const manager = newManager(store);
    manager.start();
    const port = freePort();
    const dto = manager.create({ listenPort: port, targetNodeId: TARGET_NODE, targetPort: 1 });
    manager.update(dto.id, { paused: true });
    const occupied = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } });
    try {
      expect(() => manager.update(dto.id, { paused: false })).toThrow(PortMapError);
      expect(manager.get(dto.id).state).toBe('paused');
      expect(store.get(dto.id)?.paused).toBe(true);
    } finally {
      occupied.stop(true);
    }
    expect(manager.update(dto.id, { paused: false }).state).toBe('listening');
    expect(store.get(dto.id)?.paused).toBe(false);
  });

  test('resuming retries a map whose bind failed at boot', () => {
    const store = new MemoryPortMapStore();
    const occupied = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    store.insert(row('taken', occupied.port));
    const manager = newManager(store);
    manager.start();
    expect(manager.get('taken').state).toBe('error');
    occupied.stop(true);
    expect(manager.update('taken', { paused: false }).state).toBe('listening');
  });

  test('two maps to the same node share one peer link budget', async () => {
    const manager = new PortMapManager({
      store: new MemoryPortMapStore(),
      peers: () => hangingPeers,
      reservedPorts: () => [],
      peerStreamLimit: 1,
    });
    managers.push(manager);
    manager.start();
    const firstPort = freePort();
    const secondPort = freePort();
    const first = manager.create({
      listenPort: firstPort,
      targetNodeId: TARGET_NODE,
      targetPort: 1,
    });
    const second = manager.create({
      listenPort: secondPort,
      targetNodeId: TARGET_NODE,
      targetPort: 2,
    });
    const held = await Bun.connect({
      hostname: '127.0.0.1',
      port: firstPort,
      socket: { data() {}, close() {} },
    });
    await Bun.sleep(30);
    expect(manager.get(first.id).activeConnections).toBe(1);
    let refused = false;
    await Bun.connect({
      hostname: '127.0.0.1',
      port: secondPort,
      socket: {
        data() {},
        close() {
          refused = true;
        },
      },
    });
    await Bun.sleep(50);
    expect(refused).toBe(true);
    expect(manager.get(second.id).activeConnections).toBe(0);
    held.terminate();
  });
});
