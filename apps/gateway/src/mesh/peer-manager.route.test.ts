import { afterEach, describe, expect, test } from 'bun:test';
import { createInMemoryLinkPair } from '@vibeterm/shared/link';
import type { MeshRouteMode } from '@vibeterm/shared/net';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { PeerManager } from './peer-manager';
import { dummyUplink } from './peer-test-fixtures';
import type { RouteModeHolder } from './route-degrade';
import { ImmediateScheduler, seedNodeIdentity, seedUser } from './test-support';

function fakeMode(initial: MeshRouteMode = 'auto'): RouteModeHolder & {
  set(mode: MeshRouteMode): void;
} {
  let mode = initial;
  const listeners = new Set<(next: MeshRouteMode) => void>();
  return {
    get: () => mode,
    set(next) {
      if (next === mode) return;
      mode = next;
      for (const fn of listeners) fn(next);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

describe('PeerManager route mode', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  function setup(mode: MeshRouteMode = 'auto') {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const routeMode = fakeMode(mode);
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store, async () => {
        throw new Error('no-relay');
      }),
      peerPort: 0,
      startServer: false,
      scheduler: new ImmediateScheduler(),
      routeMode,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    return { manager, self, peer, routeMode };
  }

  test('relay 模式拒绝入站 dc，不安装', () => {
    const { manager, peer } = setup('relay');
    const [local] = createInMemoryLinkPair();
    expect(manager.adoptLink(peer.nodeId, local, 'dc', peer.nodeId)).toBeNull();
    expect(manager.transportOf(peer.nodeId)).toBeNull();
  });

  test('relay 模式入站 ws-secure 同样拒绝；已有 relay live 保留', () => {
    const { manager, self, peer } = setup('relay');
    const [relayLocal, relayRemote] = createInMemoryLinkPair();
    void relayRemote;
    expect(manager.adoptLink(peer.nodeId, relayLocal, 'relay', self.nodeId)).toBe(relayLocal);
    const [dcLocal] = createInMemoryLinkPair();
    expect(manager.adoptLink(peer.nodeId, dcLocal, 'ws-secure', peer.nodeId)).toBe(relayLocal);
    expect(manager.transportOf(peer.nodeId)).toBe('relay');
  });

  test('auto 缺省立刻安装入站直连（未降级，兼容 2.3.7）', () => {
    const { manager, self, peer } = setup('auto');
    const [dcLocal] = createInMemoryLinkPair();
    expect(manager.adoptLink(peer.nodeId, dcLocal, 'dc', self.nodeId)).toBe(dcLocal);
    expect(manager.transportOf(peer.nodeId)).toBe('dc');
  });
});
