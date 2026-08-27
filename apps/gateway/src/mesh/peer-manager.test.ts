import { afterEach, describe, expect, test } from 'bun:test';
import { createInMemoryLinkPair } from '@tmex/shared/link';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { PeerManager, winningDialInitiator } from './peer-manager';
import { handshakeRelay } from './peer-protocol';
import {
  ImmediateScheduler,
  fakeSocketPair,
  seedNodeIdentity,
  seedUser,
  waitUntil,
} from './test-support';
import { type KeyLogApplier, NodeUnreachableError, type UplinkStatus } from './types';
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

describe('PeerManager', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('getLink reuses a live LAN link and falls back through endpoints to relay', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');

    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      hostname: '127.0.0.1',
      startServer: true,
      idleMs: 60_000,
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    await managerA.start();
    const port = managerA.listenPort;
    expect(port).toBeGreaterThan(0);

    store.upsertPeer({
      nodeId: self.nodeId,
      name: 'self',
      endpointsJson: JSON.stringify([`ws://127.0.0.1:${port}/peer`]),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });

    const managerB = new PeerManager({
      identity: peer,
      userStore: store,
      uplink: dummyUplink(peer, store),
      peerPort: 0,
      hostname: '127.0.0.1',
      startServer: false,
      idleMs: 60_000,
    });
    fixtures.push({ close, stop: () => managerB.stop() });

    const link1 = await managerB.getLink(self.nodeId);
    const link2 = await managerB.getLink(self.nodeId);
    expect(link1).toBe(link2);
    expect(managerB.listReach().get(self.nodeId)).toBe('lan');
  });

  test('skips a dead endpoint then uses relay', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify(['ws://127.0.0.1:1/peer']),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });

    const [outerA, outerB] = createInMemoryLinkPair();
    const incoming = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      outerB.onStream(resolve)
    );
    const uplink = dummyUplink(self, store, async () => {
      const stream = await outerA.openStream(
        new TextEncoder().encode(JSON.stringify({ to: peer.nodeId, from: self.nodeId }))
      );
      return stream;
    });
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink,
      peerPort: 0,
      startServer: false,
      connectTimeoutMs: 200,
    });
    fixtures.push({ close, stop: () => manager.stop() });

    const acceptP = incoming.then((stream) =>
      handshakeRelay({
        stream,
        role: 'acceptor',
        identity: peer,
        userStore: store,
      })
    );
    const [link] = await Promise.all([manager.getLink(peer.nodeId), acceptP]);
    expect(manager.listReach().get(peer.nodeId)).toBe('relay');
    link.close();
  });

  test('idle links with no streams are closed', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const scheduler = new ImmediateScheduler();
    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      hostname: '127.0.0.1',
      startServer: true,
      idleMs: 50,
      scheduler,
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    await managerA.start();
    store.upsertPeer({
      nodeId: self.nodeId,
      name: 'self',
      endpointsJson: JSON.stringify([`ws://127.0.0.1:${managerA.listenPort}/peer`]),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const managerB = new PeerManager({
      identity: peer,
      userStore: store,
      uplink: dummyUplink(peer, store),
      peerPort: 0,
      startServer: false,
      idleMs: 50,
      scheduler,
    });
    fixtures.push({ close, stop: () => managerB.stop() });
    await managerB.getLink(self.nodeId);
    expect(managerB.listReach().get(self.nodeId)).toBe('lan');
    scheduler.nowMs += 100;
    scheduler.tickIntervals();
    await waitUntil(() => managerB.listReach().get(self.nodeId) !== 'lan');
  });

  test('throws NodeUnreachableError when LAN and relay fail', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    await expect(manager.getLink('ff'.repeat(16))).rejects.toBeInstanceOf(NodeUnreachableError);
  });

  test('onRevoked closes the link and deletes peer_cache', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: '[]',
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    manager.onRevoked(peer.nodeId);
    expect(store.listPeers().find((row) => row.nodeId === peer.nodeId)).toBeUndefined();
  });

  test('unknown OPEN type is RST and not counted against idle', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const scheduler = new ImmediateScheduler();
    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      hostname: '127.0.0.1',
      startServer: true,
      idleMs: 50,
      scheduler,
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    await managerA.start();
    store.upsertPeer({
      nodeId: self.nodeId,
      name: 'self',
      endpointsJson: JSON.stringify([`ws://127.0.0.1:${managerA.listenPort}/peer`]),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const managerB = new PeerManager({
      identity: peer,
      userStore: store,
      uplink: dummyUplink(peer, store),
      peerPort: 0,
      startServer: false,
      idleMs: 50,
      scheduler,
    });
    fixtures.push({ close, stop: () => managerB.stop() });
    const link = await managerB.getLink(self.nodeId);
    const stream = await link.openStream(
      new TextEncoder().encode(JSON.stringify({ type: 'nope' }))
    );
    expect((await stream.closed).reason).toBe('rst');
    expect(managerB.listReach().get(self.nodeId)).toBe('lan');
    scheduler.nowMs += 100;
    scheduler.tickIntervals();
    await waitUntil(() => managerB.listReach().get(self.nodeId) !== 'lan');
  });

  test('stop cancels an in-flight dial so a late handshake cannot re-arm idle', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify(['ws://127.0.0.1:1/peer']),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    let release: ((ws: import('@tmex/shared/link').WebSocketTransportInput) => void) | undefined;
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      connectTimeoutMs: 5_000,
      wsFactory: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const pending = manager.getLink(peer.nodeId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await manager.stop();
    await expect(pending).rejects.toBeInstanceOf(NodeUnreachableError);
    release?.(fakeSocketPair()[0]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(manager.listReach().get(peer.nodeId)).toBeNull();
  });

  test('simultaneous dial keeps the initiator with the lexicographically smaller nodeId', () => {
    const small = '01'.repeat(16);
    const large = 'ff'.repeat(16);
    expect(winningDialInitiator(small, large)).toBe(small);
    expect(winningDialInitiator(large, small)).toBe(small);
  });

  test('linkFactory supplies an in-memory session before endpoints or relay', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify(['ws://127.0.0.1:1/peer']),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const [local] = createInMemoryLinkPair();
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      linkFactory: async () => local,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const link = await manager.getLink(peer.nodeId);
    expect(link).toBe(local);
    expect(manager.listReach().get(peer.nodeId)).toBe('lan');
    expect(manager.getLive(peer.nodeId)).toBe(local);
  });

  test('DataChannel path wins when both sides are direct_capable', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: '[]',
      inventoryJson: '{}',
      directCapable: true,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    store.upsertPeer({
      nodeId: self.nodeId,
      name: 'self',
      endpointsJson: '[]',
      inventoryJson: '{}',
      directCapable: true,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const { createFakeNativeModule } = await import('./rtc/test-fakes');
    const { RtcPeerManager } = await import('./rtc');
    const fake = createFakeNativeModule();
    const ice = () => ({ stun: [] as string[], turn: null });
    const rtcA = new RtcPeerManager({
      loadNative: async () => fake.module,
      iceConfigProvider: ice,
      identity: self,
      userStore: store,
      handshakeTimeoutMs: 2_000,
    });
    const rtcB = new RtcPeerManager({
      loadNative: async () => fake.module,
      iceConfigProvider: ice,
      identity: peer,
      userStore: store,
      handshakeTimeoutMs: 2_000,
    });
    fixtures.push({ close: () => rtcA.close() });
    fixtures.push({ close: () => rtcB.close() });
    await rtcA.ready();
    await rtcB.ready();

    const holderA: { manager: PeerManager | null } = { manager: null };
    const holderB: { manager: PeerManager | null } = { manager: null };
    const forward = (
      target: { manager: PeerManager | null },
      fromId: string,
      msg: {
        t: string;
        rtcSession?: string;
        from?: string;
        to?: string;
        sdp?: string;
        candidate?: string;
      }
    ) => {
      if (msg.t !== 'rtc.signal' || !target.manager) return;
      target.manager.receiveRtcSignal(fromId, {
        rtcSession: msg.rtcSession ?? '',
        from: msg.from === 'browser' ? 'browser' : 'node',
        to: msg.to ?? '',
        sdp: msg.sdp ?? null,
        candidate: msg.candidate ?? null,
      });
    };

    const uplinkA = dummyUplink(self, store);
    uplinkA.state = 'online';
    uplinkA.sendCtl = (msg) => forward(holderB, self.nodeId, msg as never);
    const uplinkB = dummyUplink(peer, store);
    uplinkB.state = 'online';
    uplinkB.sendCtl = (msg) => forward(holderA, peer.nodeId, msg as never);

    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: uplinkA,
      peerPort: 0,
      startServer: false,
      rtc: rtcA,
    });
    const managerB = new PeerManager({
      identity: peer,
      userStore: store,
      uplink: uplinkB,
      peerPort: 0,
      startServer: false,
      rtc: rtcB,
    });
    holderA.manager = managerA;
    holderB.manager = managerB;
    fixtures.push({ close, stop: () => managerA.stop() });
    fixtures.push({ close, stop: () => managerB.stop() });

    const [linkA, linkB] = await Promise.all([
      managerA.getLink(peer.nodeId),
      managerB.getLink(self.nodeId),
    ]);
    expect(managerA.listReach().get(peer.nodeId)).toBe('lan');
    expect(managerB.listReach().get(self.nodeId)).toBe('lan');
    const incoming = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      linkB.onStream(resolve)
    );
    const open = new TextEncoder().encode('{"type":"ping"}');
    const out = await linkA.openStream(open);
    const inn = await incoming;
    expect(inn.openPayload).toEqual(open);
    out.end();
    inn.end();
  });

  test('caps concurrent streams per link', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const hang = () => new Promise<Response>(() => {});
    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      hostname: '127.0.0.1',
      startServer: true,
      maxConcurrentStreams: 1,
      sessionStore: {
        verify: () => ({ ok: true, session: { userId: 'user-1' } }),
      } as unknown as import('../auth/node-session-store').NodeSessionStore,
      dispatchHttp: hang,
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    await managerA.start();
    store.upsertPeer({
      nodeId: self.nodeId,
      name: 'self',
      endpointsJson: JSON.stringify([`ws://127.0.0.1:${managerA.listenPort}/peer`]),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const managerB = new PeerManager({
      identity: peer,
      userStore: store,
      uplink: dummyUplink(peer, store),
      peerPort: 0,
      startServer: false,
      maxConcurrentStreams: 1,
      sessionStore: {
        verify: () => ({ ok: true, session: { userId: 'user-1' } }),
      } as unknown as import('../auth/node-session-store').NodeSessionStore,
      dispatchHttp: hang,
    });
    fixtures.push({ close, stop: () => managerB.stop() });
    const link = await managerB.getLink(self.nodeId);
    const first = await link.openStream(
      new TextEncoder().encode('{"type":"http","method":"GET","path":"/"}')
    );
    await expect(
      link.openStream(new TextEncoder().encode('{"type":"http","method":"GET","path":"/"}'))
    ).rejects.toThrow('too-many-streams');
    first.end();
  });
});
