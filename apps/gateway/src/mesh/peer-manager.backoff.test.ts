import { afterEach, describe, expect, test } from 'bun:test';
import { createInMemoryLinkPair } from '@tmex/shared/link';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { ENDPOINT_BACKOFF_MIN_MS, PeerEndpointBackoff } from './peer-endpoint-backoff';
import { PEER_UPGRADE_BACKOFF_CAP_MS, PEER_UPGRADE_COOLDOWN_MS, PeerManager } from './peer-manager';
import { DirectDialLimiter } from './peer-ws-race';
import {
  ImmediateScheduler,
  fakeSocketPair,
  seedNodeIdentity,
  seedUser,
  waitUntil,
} from './test-support';
import type { KeyLogApplier, UplinkStatus } from './types';
import { UplinkClient } from './uplink-client';

function dummyApplier(): KeyLogApplier {
  return {
    async head() {
      return { seq: 0n, hash: new Uint8Array(32) };
    },
    async applyMany() {
      return { applied: 0 };
    },
  };
}

function dummyUplink(
  identity: { nodeId: string; edSecretKey: Uint8Array },
  userStore: UserStore,
  openRelay?: () => Promise<import('@tmex/shared/link').LinkStream>
): UplinkClient {
  const client = new UplinkClient({
    hubUrl: 'https://hub.example.com',
    identity,
    userId: 'user-1',
    keyLogApplier: dummyApplier(),
    userStore,
    statusProvider: (): UplinkStatus => ({
      version: '1',
      tmux: false,
      direct_capable: false,
      inventory: {},
      endpoints: [],
    }),
    wsFactory: () => fakeSocketPair()[0],
  });
  if (openRelay) {
    client.openRelay = async () => openRelay();
    client.state = 'online';
    client.link = createInMemoryLinkPair()[0];
  }
  return client;
}

function echoQuiesceCaps(session: import('@tmex/shared/link').LinkSession): void {
  let helloReplied = false;
  session.ctl.onMessage((bytes) => {
    let msg: { t?: string };
    try {
      msg = JSON.parse(new TextDecoder().decode(bytes)) as { t?: string };
    } catch {
      return;
    }
    if (msg.t === 'link.hello' && !helloReplied) {
      helloReplied = true;
      session.ctl.send(
        new TextEncoder().encode(JSON.stringify({ t: 'link.hello', caps: ['quiesce'] }))
      );
    }
    if (msg.t === 'link.quiesce.probe') {
      session.ctl.send(new TextEncoder().encode(JSON.stringify({ t: 'link.quiesce.probe.ack' })));
    }
  });
}

describe('PeerManager endpoint backoff', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('unreachable LAN endpoints back off and skip the next upgrade dial', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const url = 'ws://10.0.0.9:39001/peer';
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify([url]),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const scheduler = new ImmediateScheduler();
    let wsCalls = 0;
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store, async () => {
        throw new Error('no-relay');
      }),
      peerPort: 0,
      startServer: false,
      scheduler,
      connectTimeoutMs: 20,
      dialLimiter: new DirectDialLimiter(4),
      wsFactory: () => {
        wsCalls += 1;
        throw Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
      },
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [relayA, relayB] = createInMemoryLinkPair();
    echoQuiesceCaps(relayB);
    expect(manager.adoptLink(peer.nodeId, relayA, 'relay', self.nodeId)).toBe(relayA);
    await waitUntil(() => manager.quiesceCapableOf(peer.nodeId));
    manager.notifyPeerEndpointsChanged(peer.nodeId);
    await waitUntil(() => wsCalls === 1, 2_000);
    expect(manager.linkDetailOf(peer.nodeId).directFailure?.ws).toMatch(/refused|10\.0\.0\.9/);

    scheduler.nowMs += PEER_UPGRADE_COOLDOWN_MS;
    manager.notifyPeerEndpointsChanged(peer.nodeId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(wsCalls).toBe(1);
    expect(manager.linkDetailOf(peer.nodeId).directFailure?.ws).toMatch(
      /all endpoints backing off \(next eligible in \d+s\)/
    );
  });

  test('duplicate and IPv4-mapped advertised URLs increment backoff once per dial', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const urls = [
      'ws://10.0.0.9:39001/peer',
      'ws://10.0.0.9:39001/peer',
      'ws://[::ffff:10.0.0.9]:39001/peer',
      ...Array.from({ length: 10 }, () => 'ws://10.0.0.9:39001/peer'),
    ];
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify(urls),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const scheduler = new ImmediateScheduler();
    const backoff = new PeerEndpointBackoff({ now: () => scheduler.now() });
    let wsCalls = 0;
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store, async () => {
        throw new Error('no-relay');
      }),
      peerPort: 0,
      startServer: false,
      scheduler,
      connectTimeoutMs: 20,
      dialLimiter: new DirectDialLimiter(4),
      endpointBackoff: backoff,
      wsFactory: () => {
        wsCalls += 1;
        throw Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
      },
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [relayA, relayB] = createInMemoryLinkPair();
    echoQuiesceCaps(relayB);
    expect(manager.adoptLink(peer.nodeId, relayA, 'relay', self.nodeId)).toBe(relayA);
    await waitUntil(() => manager.quiesceCapableOf(peer.nodeId));
    manager.notifyPeerEndpointsChanged(peer.nodeId);
    await waitUntil(() => wsCalls === 1, 2_000);
    expect(wsCalls).toBe(1);
    expect(backoff.nextEligibleAt(peer.nodeId, 'ws://10.0.0.9:39001/peer')).toBe(
      scheduler.now() + ENDPOINT_BACKOFF_MIN_MS
    );

    scheduler.nowMs += PEER_UPGRADE_COOLDOWN_MS;
    manager.notifyPeerEndpointsChanged(peer.nodeId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(wsCalls).toBe(1);
    expect(manager.linkDetailOf(peer.nodeId).directFailure?.ws).toMatch(
      /all endpoints backing off \(next eligible in \d+s\)/
    );
  });

  test('forceProbe bypasses backoff and still requires a trusted node', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const strangerId = 'ff'.repeat(16);
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify(['ws://10.0.0.9:39001/peer']),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    let wsCalls = 0;
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store, async () => {
        throw new Error('no-relay');
      }),
      peerPort: 0,
      startServer: false,
      connectTimeoutMs: 20,
      dialLimiter: new DirectDialLimiter(4),
      wsFactory: () => {
        wsCalls += 1;
        throw Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
      },
    });
    fixtures.push({ close, stop: () => manager.stop() });
    await manager.forceProbe(peer.nodeId);
    expect(wsCalls).toBe(1);
    await manager.forceProbe(peer.nodeId);
    expect(wsCalls).toBe(2);
    await expect(manager.forceProbe(strangerId)).rejects.toThrow(/not admitted|revoked/);
  });

  test('advertised endpoint set change resets the node backoff; fingerprint change resets all', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify(['ws://10.0.0.9:39001/peer']),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const scheduler = new ImmediateScheduler();
    let ifaces: Record<string, Array<{ address: string; family: string; internal: boolean }>> = {
      en0: [{ address: '10.0.0.8', family: 'IPv4', internal: false }],
    };
    let wsCalls = 0;
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store, async () => {
        throw new Error('no-relay');
      }),
      peerPort: 0,
      startServer: false,
      scheduler,
      connectTimeoutMs: 20,
      dialLimiter: new DirectDialLimiter(4),
      interfacesFn: () => ifaces,
      wsFactory: () => {
        wsCalls += 1;
        throw Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
      },
    });
    fixtures.push({ close, stop: () => manager.stop() });
    await manager.start();
    const [relayA, relayB] = createInMemoryLinkPair();
    echoQuiesceCaps(relayB);
    expect(manager.adoptLink(peer.nodeId, relayA, 'relay', self.nodeId)).toBe(relayA);
    await waitUntil(() => manager.quiesceCapableOf(peer.nodeId));
    manager.notifyPeerEndpointsChanged(peer.nodeId);
    await waitUntil(() => wsCalls === 1, 2_000);

    scheduler.nowMs += PEER_UPGRADE_COOLDOWN_MS;
    manager.notifyPeerEndpointsChanged(peer.nodeId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(wsCalls).toBe(1);

    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify(['ws://10.0.0.10:39001/peer']),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 2,
    });
    scheduler.nowMs += PEER_UPGRADE_BACKOFF_CAP_MS;
    manager.notifyPeerEndpointsChanged(peer.nodeId);
    await waitUntil(() => wsCalls === 2, 2_000);

    scheduler.nowMs += PEER_UPGRADE_COOLDOWN_MS;
    manager.notifyPeerEndpointsChanged(peer.nodeId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(wsCalls).toBe(2);

    ifaces = { en0: [{ address: '10.0.0.99', family: 'IPv4', internal: false }] };
    scheduler.nowMs += PEER_UPGRADE_BACKOFF_CAP_MS;
    scheduler.tickIntervals();
    await waitUntil(() => wsCalls === 3, 2_000);
  });

  test('onRevoked clears endpoint backoff so the next getLink dials again', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const peerRow = {
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify(['ws://10.0.0.9:39001/peer']),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    };
    store.upsertPeer(peerRow);
    let wsCalls = 0;
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store, async () => {
        throw new Error('no-relay');
      }),
      peerPort: 0,
      startServer: false,
      connectTimeoutMs: 20,
      dialLimiter: new DirectDialLimiter(4),
      wsFactory: () => {
        wsCalls += 1;
        throw Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
      },
    });
    fixtures.push({ close, stop: () => manager.stop() });
    await expect(manager.getLink(peer.nodeId)).rejects.toThrow();
    expect(wsCalls).toBe(1);
    await expect(manager.getLink(peer.nodeId)).rejects.toThrow();
    expect(wsCalls).toBe(1);
    const cert = store.getCert(peer.nodeId);
    manager.onRevoked(peer.nodeId);
    if (cert) store.upsertCert(cert);
    store.upsertPeer({ ...peerRow, listVersion: 2 });
    await expect(manager.getLink(peer.nodeId)).rejects.toThrow();
    expect(wsCalls).toBe(2);
  });

  test('protocol failures are not cached so the next dial still tries the address', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify(['ws://10.0.0.9:39001/peer']),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const scheduler = new ImmediateScheduler();
    let wsCalls = 0;
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store, async () => {
        throw new Error('no-relay');
      }),
      peerPort: 0,
      startServer: false,
      scheduler,
      connectTimeoutMs: 20,
      dialLimiter: new DirectDialLimiter(4),
      wsFactory: () => {
        wsCalls += 1;
        throw new Error('peer-id-mismatch');
      },
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [relayA, relayB] = createInMemoryLinkPair();
    echoQuiesceCaps(relayB);
    expect(manager.adoptLink(peer.nodeId, relayA, 'relay', self.nodeId)).toBe(relayA);
    await waitUntil(() => manager.quiesceCapableOf(peer.nodeId));
    manager.notifyPeerEndpointsChanged(peer.nodeId);
    await waitUntil(() => wsCalls === 1, 2_000);
    scheduler.nowMs += PEER_UPGRADE_COOLDOWN_MS;
    manager.notifyPeerEndpointsChanged(peer.nodeId);
    await waitUntil(() => wsCalls === 2, 2_000);
  });
});
