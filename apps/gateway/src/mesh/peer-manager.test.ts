import { afterEach, describe, expect, test } from 'bun:test';
import { generateEd25519KeyPair, randomBytes } from '@tmex/shared/auth';
import { createInMemoryLinkPair } from '@tmex/shared/link';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { defaultScheduler, encodeJsonBytes } from './ctl';
import {
  PEER_DC_UPGRADE_RETRY_DELAYS_MS,
  PEER_DC_UPGRADE_RETRY_TAIL_MS,
  PEER_RTC_WAKE_COOLDOWN_MS,
  PEER_RTC_WAKE_NONCE_CACHE,
  PEER_RTC_WAKE_VERIFY_BURST,
  PEER_RTC_WAKE_VERIFY_WINDOW_MS,
  PEER_UPGRADE_BACKOFF_CAP_MS,
  PEER_UPGRADE_COOLDOWN_MS,
  PeerManager,
  winningDialInitiator,
} from './peer-manager';
import { handshakeRelay } from './peer-protocol';
import type { RtcPeerManager } from './rtc';
import { encodeRtcWakeSdp, peerRtcSession } from './rtc/ice';
import type { RtcLivenessOptions } from './rtc/rtc-peer-manager';
import { FakeClock } from './rtc/test-fakes';
import {
  ImmediateScheduler,
  fakeSocketPair,
  seedNodeIdentity,
  seedUser,
  waitUntil,
} from './test-support';
import {
  type KeyLogApplier,
  type MeshScheduler,
  NodeUnreachableError,
  type UplinkStatus,
} from './types';
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

const SMALL_NODE_ID = new Uint8Array(16).fill(0x01);
const LARGE_NODE_ID = new Uint8Array(16).fill(0xff);

async function setupDirectRtcPair(
  fixtures: Array<{ close: () => void; stop?: () => Promise<void> }>,
  opts?: {
    smallDirectCapable?: boolean;
    largeDirectCapable?: boolean;
    now?: () => number;
    scheduler?: MeshScheduler;
    liveness?: RtcLivenessOptions | false;
  }
) {
  const { db, close } = createMigratedAuthDb();
  fixtures.push({ close });
  const store = new UserStore(db);
  seedUser(store);
  const small = seedNodeIdentity(store, 'user-1', { nodeId: SMALL_NODE_ID });
  const large = seedNodeIdentity(store, 'user-1', { nodeId: LARGE_NODE_ID });
  const upsert = (nodeId: string, name: string, directCapable: boolean) => {
    store.upsertPeer({
      nodeId,
      name,
      endpointsJson: '[]',
      inventoryJson: '{}',
      directCapable,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
  };
  upsert(small.nodeId, 'small', opts?.smallDirectCapable ?? true);
  upsert(large.nodeId, 'large', opts?.largeDirectCapable ?? true);
  const { createFakeNativeModule } = await import('./rtc/test-fakes');
  const { RtcPeerManager } = await import('./rtc');
  const fake = createFakeNativeModule();
  const ice = () => ({ stun: ['stun:stun.example:3478'] as string[], turn: null });
  const rtcSmall = new RtcPeerManager({
    loadNative: async () => fake.module,
    iceConfigProvider: ice,
    identity: small,
    userStore: store,
    handshakeTimeoutMs: 2_000,
    liveness: opts?.liveness,
  });
  const rtcLarge = new RtcPeerManager({
    loadNative: async () => fake.module,
    iceConfigProvider: ice,
    identity: large,
    userStore: store,
    handshakeTimeoutMs: 2_000,
    liveness: opts?.liveness,
  });
  fixtures.push({ close: () => rtcSmall.close() });
  fixtures.push({ close: () => rtcLarge.close() });
  await rtcSmall.ready();
  await rtcLarge.ready();
  const holderSmall: { manager: PeerManager | null } = { manager: null };
  const holderLarge: { manager: PeerManager | null } = { manager: null };
  const wakes: string[] = [];
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
    if (typeof msg.sdp === 'string' && msg.sdp.includes('rtc.wake')) {
      wakes.push(fromId);
    }
    target.manager.receiveRtcSignal(fromId, {
      rtcSession: msg.rtcSession ?? '',
      from: msg.from === 'browser' ? 'browser' : 'node',
      to: msg.to ?? '',
      sdp: msg.sdp ?? null,
      candidate: msg.candidate ?? null,
    });
  };
  const uplinkSmall = dummyUplink(small, store);
  uplinkSmall.state = 'online';
  uplinkSmall.sendCtl = (msg) => forward(holderLarge, small.nodeId, msg as never);
  const uplinkLarge = dummyUplink(large, store);
  uplinkLarge.state = 'online';
  uplinkLarge.sendCtl = (msg) => forward(holderSmall, large.nodeId, msg as never);
  const managerSmall = new PeerManager({
    identity: small,
    userStore: store,
    uplink: uplinkSmall,
    peerPort: 0,
    startServer: false,
    rtc: rtcSmall,
    now: opts?.now,
    scheduler: opts?.scheduler,
  });
  const managerLarge = new PeerManager({
    identity: large,
    userStore: store,
    uplink: uplinkLarge,
    peerPort: 0,
    startServer: false,
    rtc: rtcLarge,
    now: opts?.now,
    scheduler: opts?.scheduler,
  });
  holderSmall.manager = managerSmall;
  holderLarge.manager = managerLarge;
  fixtures.push({ close, stop: () => managerSmall.stop() });
  fixtures.push({ close, stop: () => managerLarge.stop() });
  return { store, small, large, managerSmall, managerLarge, wakes, fake };
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

  test('getLink refuses un-admitted nodes and does not dial a reachable endpoint', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const ghostId = 'ff'.repeat(16);
    let dials = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Response('no', { status: 404 });
      },
      websocket: {
        open() {
          dials += 1;
        },
        message() {},
        close() {},
      },
    });
    fixtures.push({ close: () => server.stop(true) });
    store.upsertPeer({
      nodeId: ghostId,
      name: 'ghost',
      endpointsJson: JSON.stringify([`ws://127.0.0.1:${server.port}/peer`]),
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
      connectTimeoutMs: 200,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    await expect(manager.getLink(ghostId)).rejects.toMatchObject({ message: 'not admitted' });
    expect(dials).toBe(0);
    expect(manager.listReach().has(ghostId)).toBe(false);
  });

  test('upgrades a live relay to dc and keeps in-flight streams on the old link', async () => {
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

    const [relayA, relayB] = createInMemoryLinkPair();
    expect(managerA.adoptLink(peer.nodeId, relayA, 'relay', self.nodeId)).toBe(relayA);
    expect(managerB.adoptLink(self.nodeId, relayB, 'relay', self.nodeId)).toBe(relayB);
    expect(managerA.transportOf(peer.nodeId)).toBe('relay');

    const first = await managerA.getLink(peer.nodeId);
    expect(first).toBe(relayA);
    void managerB.getLink(self.nodeId);
    await waitUntil(() => managerA.transportOf(peer.nodeId) === 'dc', 5_000);
    const upgraded = await managerA.getLink(peer.nodeId);
    expect(upgraded).not.toBe(relayA);
    expect(managerA.transportOf(peer.nodeId)).toBe('dc');
  });

  test('relay upgrades try DC then ws-secure; failed DC does not stick to the old link', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const { createFakeNativeModule } = await import('./rtc/test-fakes');
    const { RtcPeerManager } = await import('./rtc');
    const fake = createFakeNativeModule();
    const rtc = new RtcPeerManager({
      loadNative: async () => fake.module,
      iceConfigProvider: () => ({ stun: [], turn: null }),
      identity: self,
      userStore: store,
    });
    fixtures.push({ close: () => rtc.close() });
    await rtc.ready();
    rtc.connectToPeer = async () => {
      throw new Error('dc-failed');
    };
    const [wsA, wsB] = createInMemoryLinkPair();
    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      rtc,
      linkFactory: async () => wsA,
    });
    const managerB = new PeerManager({
      identity: peer,
      userStore: store,
      uplink: dummyUplink(peer, store),
      peerPort: 0,
      startServer: false,
      linkFactory: async () => wsB,
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    fixtures.push({ close, stop: () => managerB.stop() });
    const [relayA, relayB] = createInMemoryLinkPair();
    expect(managerA.adoptLink(peer.nodeId, relayA, 'relay', self.nodeId)).toBe(relayA);
    expect(managerB.adoptLink(self.nodeId, relayB, 'relay', self.nodeId)).toBe(relayB);
    const first = await managerA.getLink(peer.nodeId);
    expect(first).toBe(relayA);
    await waitUntil(() => managerA.transportOf(peer.nodeId) === 'ws-secure', 5_000);
    const upgraded = await managerA.getLink(peer.nodeId);
    expect(upgraded).not.toBe(relayA);
    expect(managerA.transportOf(peer.nodeId)).toBe('ws-secure');
  });

  test('upgrade keeps an in-flight stream on the old link; revoke closes active and retiring', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const [relayA, relayB] = createInMemoryLinkPair();
    echoQuiesceCaps(relayB);
    const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      relayB.onStream(resolve)
    );
    const [wsA, wsHold] = createInMemoryLinkPair();
    fixtures.push({ close: () => wsHold.close('test') });
    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      idleMs: 60_000,
      rtc: {
        available: true,
        connectToPeer: async () => {
          throw new Error('skip-dc');
        },
      } as unknown as import('./rtc').RtcPeerManager,
      linkFactory: async () => wsA,
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    expect(managerA.adoptLink(peer.nodeId, relayA, 'relay', self.nodeId)).toBe(relayA);
    await waitUntil(() => managerA.quiesceCapableOf(peer.nodeId));
    const oldStream = await relayA.openStream(new TextEncoder().encode('{"type":"keep"}'));
    const incoming = await incomingP;
    await oldStream.write(new TextEncoder().encode('still-alive'));
    const first = await managerA.getLink(peer.nodeId);
    expect(first).toBe(relayA);
    await waitUntil(() => managerA.transportOf(peer.nodeId) === 'ws-secure', 5_000);
    const upgraded = await managerA.getLink(peer.nodeId);
    expect(upgraded).not.toBe(relayA);
    const reader = incoming.readable.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value?.bytes)).toBe('still-alive');
    const oldClosed = relayA.closed;
    const newClosed = upgraded.closed;
    managerA.onRevoked(peer.nodeId);
    expect((await oldClosed).reason).toBeTruthy();
    expect((await newClosed).reason).toBeTruthy();
    incoming.end();
  });

  test('failed DC attempts unsubscribe signaling listeners so the count stays stable', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    let deliveries = 0;
    let attempts = 0;
    let tryDc = true;
    const scheduler = new ImmediateScheduler();
    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler,
      rtc: {
        get available() {
          return tryDc;
        },
        connectToPeer: async (
          _id: string,
          signaling: { onMessage: (cb: (msg: unknown) => void) => () => void }
        ) => {
          attempts += 1;
          signaling.onMessage(() => {
            deliveries += 1;
          });
          throw new Error('dc-failed');
        },
      } as unknown as import('./rtc').RtcPeerManager,
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    const [relayA, relayB] = createInMemoryLinkPair();
    fixtures.push({ close: () => relayB.close('test') });
    echoQuiesceCaps(relayB);
    expect(managerA.adoptLink(peer.nodeId, relayA, 'relay', self.nodeId)).toBe(relayA);
    await waitUntil(() => managerA.quiesceCapableOf(peer.nodeId));
    await waitUntil(() => {
      scheduler.nowMs += PEER_UPGRADE_BACKOFF_CAP_MS;
      void managerA.getLink(peer.nodeId);
      return attempts >= 3;
    }, 5_000);
    expect(attempts).toBeGreaterThanOrEqual(3);
    tryDc = false;
    await Bun.sleep(20);
    managerA.receiveRtcSignal(peer.nodeId, {
      rtcSession: 'dc:x:y',
      from: 'node',
      to: self.nodeId,
      sdp: 'leftover',
    });
    expect(deliveries).toBe(0);
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

  test('upgrades a live relay to ws-secure when peer endpoints appear without getLink', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const managerB = new PeerManager({
      identity: peer,
      userStore: store,
      uplink: dummyUplink(peer, store),
      peerPort: 0,
      hostname: '127.0.0.1',
      startServer: true,
      idleMs: 60_000,
    });
    fixtures.push({ close, stop: () => managerB.stop() });
    await managerB.start();
    const port = managerB.listenPort;
    expect(port).toBeGreaterThan(0);

    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: '[]',
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      idleMs: 60_000,
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    const [relayA, relayB] = createInMemoryLinkPair();
    expect(managerA.adoptLink(peer.nodeId, relayA, 'relay', self.nodeId)).toBe(relayA);
    expect(managerB.adoptLink(self.nodeId, relayB, 'relay', self.nodeId)).toBe(relayB);
    expect(managerA.transportOf(peer.nodeId)).toBe('relay');
    await waitUntil(() => managerA.quiesceCapableOf(peer.nodeId));

    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify([`ws://127.0.0.1:${port}/peer`]),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 2,
    });
    managerA.notifyPeerEndpointsChanged(peer.nodeId);
    await waitUntil(() => managerA.transportOf(peer.nodeId) === 'ws-secure', 5_000);
    const upgraded = managerA.getLive(peer.nodeId);
    expect(upgraded).not.toBe(relayA);
    expect(managerA.listReach().get(peer.nodeId)).toBe('lan');
  });

  test('rate-limits background upgrade dials for unchanged endpoints', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify(['ws://127.0.0.1:39001/peer']),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const scheduler = new ImmediateScheduler();
    let dials = 0;
    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler,
      linkFactory: async () => {
        dials += 1;
        throw new Error('dial-failed');
      },
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    const [relayA, relayB] = createInMemoryLinkPair();
    echoQuiesceCaps(relayB);
    expect(managerA.adoptLink(peer.nodeId, relayA, 'relay', self.nodeId)).toBe(relayA);
    await waitUntil(() => managerA.quiesceCapableOf(peer.nodeId));
    managerA.notifyPeerEndpointsChanged(peer.nodeId);
    await waitUntil(() => dials === 1, 2_000);
    managerA.notifyPeerEndpointsChanged(peer.nodeId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(dials).toBe(1);
    scheduler.nowMs += PEER_UPGRADE_COOLDOWN_MS;
    managerA.notifyPeerEndpointsChanged(peer.nodeId);
    await waitUntil(() => dials === 2, 2_000);
    expect(managerA.transportOf(peer.nodeId)).toBe('relay');
  });

  test('single-sided getLink from the larger node id still establishes dc via wake', async () => {
    const { small, large, managerSmall, managerLarge, wakes } = await setupDirectRtcPair(fixtures);
    expect(large.nodeId.toLowerCase() > small.nodeId.toLowerCase()).toBe(true);
    const link = await managerLarge.getLink(small.nodeId);
    expect(link).toBeTruthy();
    await waitUntil(() => managerLarge.transportOf(small.nodeId) === 'dc', 5_000);
    await waitUntil(() => managerSmall.transportOf(large.nodeId) === 'dc', 5_000);
    expect(managerLarge.transportOf(small.nodeId)).toBe('dc');
    expect(managerSmall.transportOf(large.nodeId)).toBe('dc');
    expect(wakes.length).toBeGreaterThanOrEqual(1);
    expect(wakes.every((from) => from === large.nodeId)).toBe(true);
  });

  test('rtc wake is coalesced and ignored once the peer is already dc', async () => {
    const { small, large, managerLarge, wakes } = await setupDirectRtcPair(fixtures);
    const first = managerLarge.getLink(small.nodeId);
    const second = managerLarge.getLink(small.nodeId);
    await Promise.all([first, second]);
    await waitUntil(() => managerLarge.transportOf(small.nodeId) === 'dc', 5_000);
    const sent = wakes.length;
    expect(sent).toBe(1);
    managerLarge.receiveRtcSignal(small.nodeId, {
      rtcSession: `dc:${small.nodeId}:${large.nodeId}`,
      from: 'node',
      to: large.nodeId,
      sdp: JSON.stringify({ type: 'rtc.wake' }),
    });
    await Bun.sleep(20);
    expect(wakes.length).toBe(sent);
    expect(managerLarge.transportOf(small.nodeId)).toBe('dc');
  });

  test('waitForTransport resolves early for dc and returns false on timeout', async () => {
    const { small, large, managerLarge } = await setupDirectRtcPair(fixtures);
    const timedOut = await managerLarge.waitForTransport(small.nodeId, 'dc', 30);
    expect(timedOut).toBe(false);
    const waiting = managerLarge.waitForTransport(small.nodeId, 'dc', 5_000);
    await managerLarge.getLink(small.nodeId);
    expect(await waiting).toBe(true);
    expect(await managerLarge.waitForTransport(small.nodeId, 'dc', 50)).toBe(true);
  });

  test('waitForTransport resolves false when stop() runs before transport arrives', async () => {
    const { small, large, managerLarge } = await setupDirectRtcPair(fixtures);
    const waiting = managerLarge.waitForTransport(small.nodeId, 'dc', 30_000);
    await managerLarge.stop();
    expect(await waiting).toBe(false);
  });

  test('waitForTransport cancels the timeout sleep after an early dc success', async () => {
    const inner = defaultScheduler();
    const state = { active: 0 };
    const scheduler: MeshScheduler = {
      now: inner.now,
      sleep(ms, signal) {
        state.active += 1;
        return inner.sleep(ms, signal).finally(() => {
          state.active -= 1;
        });
      },
      interval: inner.interval.bind(inner),
    };
    const { small, large, managerLarge } = await setupDirectRtcPair(fixtures, { scheduler });
    const waiting = managerLarge.waitForTransport(small.nodeId, 'dc', 30_000);
    await managerLarge.getLink(small.nodeId);
    expect(await waiting).toBe(true);
    await waitUntil(() => state.active === 0, 1_000);
    expect(state.active).toBe(0);
  });

  test('revoking a peer resolves outstanding waitForTransport waiters false', async () => {
    const { store, small, large, managerLarge } = await setupDirectRtcPair(fixtures);
    const waiting = managerLarge.waitForTransport(small.nodeId, 'dc', 30_000);
    store.markCertRevoked(small.nodeId, 9);
    managerLarge.onRevoked(small.nodeId);
    expect(await waiting).toBe(false);
  });

  test('unsigned, bad-signature, skewed, replayed, and spoofed-from wakes do not create a PeerConnection', async () => {
    const clock = { ms: Date.now() };
    const { small, large, managerSmall, fake } = await setupDirectRtcPair(fixtures, {
      now: () => clock.ms,
    });
    const session = peerRtcSession(small.nodeId, large.nodeId);
    const inject = (sdp: string) => {
      managerSmall.receiveRtcSignal(large.nodeId, {
        rtcSession: session,
        from: 'node',
        to: small.nodeId,
        sdp,
      });
    };
    inject(JSON.stringify({ type: 'rtc.wake' }));
    expect(fake.connections).toHaveLength(0);

    clock.ms += PEER_RTC_WAKE_COOLDOWN_MS + 1;
    const other = generateEd25519KeyPair();
    inject(
      encodeRtcWakeSdp({
        from: large.nodeId,
        to: small.nodeId,
        rtcSession: session,
        issuedAt: clock.ms,
        secretKey: other.secretKey,
      })
    );
    expect(fake.connections).toHaveLength(0);

    clock.ms += PEER_RTC_WAKE_COOLDOWN_MS + 1;
    inject(
      encodeRtcWakeSdp({
        from: large.nodeId,
        to: small.nodeId,
        rtcSession: session,
        issuedAt: clock.ms - 120_000,
        secretKey: large.edSecretKey,
      })
    );
    expect(fake.connections).toHaveLength(0);

    clock.ms += PEER_RTC_WAKE_COOLDOWN_MS + 1;

    const nonce = randomBytes(16);
    const good = encodeRtcWakeSdp({
      from: large.nodeId,
      to: small.nodeId,
      rtcSession: session,
      issuedAt: clock.ms,
      secretKey: large.edSecretKey,
      nonce,
    });
    inject(good);
    await waitUntil(() => fake.connections.length > 0, 2_000);
    const afterGood = fake.connections.length;
    clock.ms += PEER_RTC_WAKE_COOLDOWN_MS + 1;
    inject(good);
    await Bun.sleep(20);
    expect(fake.connections).toHaveLength(afterGood);

    clock.ms += PEER_RTC_WAKE_COOLDOWN_MS + 1;
    inject(
      encodeRtcWakeSdp({
        from: small.nodeId,
        to: large.nodeId,
        rtcSession: session,
        issuedAt: clock.ms,
        secretKey: large.edSecretKey,
      })
    );
    await Bun.sleep(20);
    expect(fake.connections).toHaveLength(afterGood);
  });

  test('receiver drops wake when it is not the offerer for the pair', async () => {
    const { small, large, managerLarge, fake } = await setupDirectRtcPair(fixtures);
    managerLarge.receiveRtcSignal(small.nodeId, {
      rtcSession: peerRtcSession(small.nodeId, large.nodeId),
      from: 'node',
      to: large.nodeId,
      sdp: encodeRtcWakeSdp({
        from: small.nodeId,
        to: large.nodeId,
        rtcSession: peerRtcSession(small.nodeId, large.nodeId),
        issuedAt: Date.now(),
        secretKey: small.edSecretKey,
      }),
    });
    await Bun.sleep(30);
    expect(fake.connections).toHaveLength(0);
    expect(managerLarge.transportOf(small.nodeId)).toBeNull();
  });

  test('a forged wake does not commit cooldown so a legitimate wake can still dial', async () => {
    const clock = { ms: Date.now() };
    const { small, large, managerSmall, fake } = await setupDirectRtcPair(fixtures, {
      now: () => clock.ms,
    });
    const session = peerRtcSession(small.nodeId, large.nodeId);
    const inject = (sdp: string) => {
      managerSmall.receiveRtcSignal(large.nodeId, {
        rtcSession: session,
        from: 'node',
        to: small.nodeId,
        sdp,
      });
    };
    inject(
      encodeRtcWakeSdp({
        from: large.nodeId,
        to: small.nodeId,
        rtcSession: session,
        issuedAt: clock.ms,
        secretKey: generateEd25519KeyPair().secretKey,
      })
    );
    expect(fake.connections).toHaveLength(0);
    inject(
      encodeRtcWakeSdp({
        from: large.nodeId,
        to: small.nodeId,
        rtcSession: session,
        issuedAt: clock.ms,
        secretKey: large.edSecretKey,
      })
    );
    await waitUntil(() => fake.connections.length > 0, 2_000);
  });

  test('wake verification is bounded by a per-peer token bucket', async () => {
    expect(PEER_RTC_WAKE_VERIFY_BURST).toBe(5);
    expect(PEER_RTC_WAKE_VERIFY_WINDOW_MS).toBe(5_000);
    const clock = { ms: Date.now() };
    const { small, large, managerSmall, fake } = await setupDirectRtcPair(fixtures, {
      now: () => clock.ms,
    });
    const session = peerRtcSession(small.nodeId, large.nodeId);
    const inject = (sdp: string) => {
      managerSmall.receiveRtcSignal(large.nodeId, {
        rtcSession: session,
        from: 'node',
        to: small.nodeId,
        sdp,
      });
    };
    const forged = () =>
      encodeRtcWakeSdp({
        from: large.nodeId,
        to: small.nodeId,
        rtcSession: session,
        issuedAt: clock.ms,
        secretKey: generateEd25519KeyPair().secretKey,
      });
    const good = () =>
      encodeRtcWakeSdp({
        from: large.nodeId,
        to: small.nodeId,
        rtcSession: session,
        issuedAt: clock.ms,
        secretKey: large.edSecretKey,
      });
    for (let i = 0; i < PEER_RTC_WAKE_VERIFY_BURST; i++) inject(forged());
    expect(fake.connections).toHaveLength(0);
    inject(good());
    await Bun.sleep(20);
    expect(fake.connections).toHaveLength(0);
    clock.ms += PEER_RTC_WAKE_VERIFY_WINDOW_MS / PEER_RTC_WAKE_VERIFY_BURST + 1;
    inject(good());
    await waitUntil(() => fake.connections.length > 0, 2_000);
  });

  test('incoming wake cooldown survives dropPeer so DC churn cannot immediately redial', async () => {
    const clock = { ms: Date.now() };
    const { small, large, managerSmall, managerLarge, fake } = await setupDirectRtcPair(fixtures, {
      now: () => clock.ms,
    });
    await managerLarge.getLink(small.nodeId);
    await waitUntil(() => managerLarge.transportOf(small.nodeId) === 'dc', 5_000);
    await waitUntil(() => managerSmall.transportOf(large.nodeId) === 'dc', 5_000);
    const afterDc = fake.connections.length;
    managerLarge.getLive(small.nodeId)?.close('drop-dc');
    managerSmall.getLive(large.nodeId)?.close('drop-dc');
    await waitUntil(() => managerSmall.transportOf(large.nodeId) === null, 2_000);
    managerSmall.receiveRtcSignal(large.nodeId, {
      rtcSession: peerRtcSession(small.nodeId, large.nodeId),
      from: 'node',
      to: small.nodeId,
      sdp: encodeRtcWakeSdp({
        from: large.nodeId,
        to: small.nodeId,
        rtcSession: peerRtcSession(small.nodeId, large.nodeId),
        issuedAt: clock.ms,
        secretKey: large.edSecretKey,
      }),
    });
    await Bun.sleep(30);
    expect(fake.connections.length).toBe(afterDc);
    clock.ms += PEER_RTC_WAKE_COOLDOWN_MS + 1;
    managerSmall.receiveRtcSignal(large.nodeId, {
      rtcSession: peerRtcSession(small.nodeId, large.nodeId),
      from: 'node',
      to: small.nodeId,
      sdp: encodeRtcWakeSdp({
        from: large.nodeId,
        to: small.nodeId,
        rtcSession: peerRtcSession(small.nodeId, large.nodeId),
        issuedAt: clock.ms,
        secretKey: large.edSecretKey,
      }),
    });
    await waitUntil(() => fake.connections.length > afterDc, 2_000);
  });

  test('replay cache is per-peer and retains nonces for the full validity window', async () => {
    const clock = { ms: Date.now() };
    const { store, large, managerLarge } = await setupDirectRtcPair(fixtures, {
      now: () => clock.ms,
    });
    expect(PEER_RTC_WAKE_NONCE_CACHE).toBe(256);
    const peers: Array<{ nodeId: string; secretKey: Uint8Array; first: string }> = [];
    const rounds = 22;
    for (let i = 0; i < 12; i++) {
      const peer = seedNodeIdentity(store, 'user-1');
      peers.push({ nodeId: peer.nodeId, secretKey: peer.edSecretKey, first: '' });
    }
    for (let round = 0; round < rounds; round++) {
      if (round > 0) clock.ms += PEER_RTC_WAKE_COOLDOWN_MS + 1;
      const issuedAt = clock.ms + 60_000;
      for (const peer of peers) {
        const nonce = randomBytes(16);
        const sdp = encodeRtcWakeSdp({
          from: peer.nodeId,
          to: large.nodeId,
          rtcSession: peerRtcSession(peer.nodeId, large.nodeId),
          issuedAt,
          secretKey: peer.secretKey,
          nonce,
        });
        if (round === 0) peer.first = sdp;
        managerLarge.receiveRtcSignal(peer.nodeId, {
          rtcSession: peerRtcSession(peer.nodeId, large.nodeId),
          from: 'node',
          to: large.nodeId,
          sdp,
        });
      }
    }
    clock.ms += PEER_RTC_WAKE_COOLDOWN_MS + 1;
    const first = peers[0];
    if (!first) throw new Error('missing peer');
    const capture = (sdp: string): string[] => {
      const lines: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      };
      try {
        managerLarge.receiveRtcSignal(first.nodeId, {
          rtcSession: peerRtcSession(first.nodeId, large.nodeId),
          from: 'node',
          to: large.nodeId,
          sdp,
        });
      } finally {
        console.log = orig;
      }
      return lines;
    };
    const replayed = capture(first.first);
    expect(replayed.some((line) => line.includes('dropped=auth'))).toBe(true);
  });

  test('receiver rate-limits wake handling before logging', async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const { small, large, managerSmall } = await setupDirectRtcPair(fixtures);
      const session = peerRtcSession(small.nodeId, large.nodeId);
      const payload = encodeRtcWakeSdp({
        from: large.nodeId,
        to: small.nodeId,
        rtcSession: session,
        issuedAt: Date.now(),
        secretKey: large.edSecretKey,
      });
      const inject = () => {
        managerSmall.receiveRtcSignal(large.nodeId, {
          rtcSession: session,
          from: 'node',
          to: small.nodeId,
          sdp: payload,
        });
      };
      inject();
      inject();
      inject();
      const wakeLines = lines.filter((line) => line.includes('kind=wake'));
      expect(wakeLines.length).toBeLessThanOrEqual(2);
    } finally {
      console.log = orig;
    }
  });

  test('sender cooldown defers a needed wake instead of swallowing it', async () => {
    const inner = defaultScheduler();
    let nowMs = inner.now();
    const queued: Array<{
      resolve: () => void;
      reject: (err: unknown) => void;
      signal?: AbortSignal;
      onAbort: () => void;
    }> = [];
    const scheduler: MeshScheduler & { flush: () => void } = {
      now: () => nowMs,
      interval: inner.interval.bind(inner),
      sleep(ms, signal) {
        if (signal?.aborted) {
          return Promise.reject(signal.reason ?? new Error('aborted'));
        }
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            const idx = queued.findIndex((row) => row.resolve === resolve);
            if (idx >= 0) queued.splice(idx, 1);
            reject(signal?.reason ?? new Error('aborted'));
          };
          queued.push({ resolve, reject, signal, onAbort });
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
      flush() {
        nowMs += PEER_RTC_WAKE_COOLDOWN_MS + 1;
        const rows = queued.splice(0);
        for (const row of rows) {
          row.signal?.removeEventListener('abort', row.onAbort);
          row.resolve();
        }
      },
    };
    const { small, large, managerSmall, managerLarge, wakes } = await setupDirectRtcPair(fixtures, {
      scheduler,
      now: () => nowMs,
    });
    await managerLarge.getLink(small.nodeId);
    await waitUntil(() => managerLarge.transportOf(small.nodeId) === 'dc', 5_000);
    await waitUntil(() => managerSmall.transportOf(large.nodeId) === 'dc', 5_000);
    const firstWakes = wakes.length;
    managerLarge.getLive(small.nodeId)?.close('drop-dc');
    managerSmall.getLive(large.nodeId)?.close('drop-dc');
    await waitUntil(() => managerLarge.transportOf(small.nodeId) === null, 2_000);
    const relink = managerLarge.getLink(small.nodeId);
    await Bun.sleep(30);
    expect(wakes.length).toBe(firstWakes);
    expect(queued.length).toBeGreaterThan(0);
    scheduler.flush();
    await waitUntil(() => wakes.length > firstWakes, 2_000);
    await relink;
    await waitUntil(() => managerLarge.transportOf(small.nodeId) === 'dc', 5_000);
    await waitUntil(() => managerSmall.transportOf(large.nodeId) === 'dc', 5_000);
  });

  test('flipping direct_capable schedules upgrade so a larger-id live relay still reaches dc', async () => {
    const { store, small, large, managerSmall, managerLarge } = await setupDirectRtcPair(fixtures, {
      smallDirectCapable: false,
      largeDirectCapable: true,
    });
    const [relayLarge, relaySmall] = createInMemoryLinkPair();
    echoQuiesceCaps(relaySmall);
    echoQuiesceCaps(relayLarge);
    expect(managerLarge.adoptLink(small.nodeId, relayLarge, 'relay', large.nodeId)).toBe(
      relayLarge
    );
    expect(managerSmall.adoptLink(large.nodeId, relaySmall, 'relay', large.nodeId)).toBe(
      relaySmall
    );
    await waitUntil(() => managerLarge.quiesceCapableOf(small.nodeId));
    await waitUntil(() => managerSmall.quiesceCapableOf(large.nodeId));
    expect(managerLarge.transportOf(small.nodeId)).toBe('relay');
    store.upsertPeer({
      nodeId: small.nodeId,
      name: 'small',
      endpointsJson: '[]',
      inventoryJson: '{}',
      directCapable: true,
      lastSeenAt: Date.now(),
      listVersion: 2,
    });
    managerLarge.notifyPeerEndpointsChanged(small.nodeId);
    await waitUntil(() => managerLarge.transportOf(small.nodeId) === 'dc', 5_000);
    await waitUntil(() => managerSmall.transportOf(large.nodeId) === 'dc', 5_000);
  });

  test('dc liveness timeout falls back within timeout+interval and respects wake cooldown', async () => {
    const clock = new FakeClock();
    const { small, large, managerSmall, managerLarge, fake, wakes } = await setupDirectRtcPair(
      fixtures,
      {
        liveness: {
          intervalMs: 30,
          timeoutMs: 100,
          now: clock.now,
          setTimeoutFn: clock.setTimeout,
          clearTimeoutFn: clock.clearTimeout,
        },
      }
    );
    await managerLarge.getLink(small.nodeId);
    await waitUntil(() => managerLarge.transportOf(small.nodeId) === 'dc', 5_000);
    await waitUntil(() => managerSmall.transportOf(large.nodeId) === 'dc', 5_000);
    const firstWakes = wakes.length;
    const afterDc = fake.connections.length;
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      for (const pc of fake.connections) {
        for (const dc of [...pc.created, ...pc.inbound]) {
          dc.dropSend = true;
        }
      }
      clock.advance(100 + 30);
      await waitUntil(() => managerLarge.transportOf(small.nodeId) !== 'dc', 2_000);
      expect(managerLarge.transportOf(small.nodeId)).not.toBe('dc');
      await waitUntil(() => managerSmall.transportOf(large.nodeId) !== 'dc', 2_000);
      expect(
        lines.some(
          (line) => line.includes('[mesh][rtc] liveness timeout') && line.includes('idle_ms=')
        )
      ).toBe(true);
    } finally {
      console.log = orig;
    }

    managerSmall.receiveRtcSignal(large.nodeId, {
      rtcSession: peerRtcSession(small.nodeId, large.nodeId),
      from: 'node',
      to: small.nodeId,
      sdp: encodeRtcWakeSdp({
        from: large.nodeId,
        to: small.nodeId,
        rtcSession: peerRtcSession(small.nodeId, large.nodeId),
        issuedAt: Date.now(),
        secretKey: large.edSecretKey,
      }),
    });
    await Bun.sleep(30);
    expect(fake.connections.length).toBe(afterDc);
    expect(wakes.length).toBe(firstWakes);

    void managerLarge.getLink(small.nodeId).catch(() => undefined);
    await Bun.sleep(30);
    expect(wakes.length).toBe(firstWakes);
  });

  test('direct-link loss retries upgrade on the bounded schedule while relay stays up', async () => {
    expect(PEER_DC_UPGRADE_RETRY_DELAYS_MS).toEqual([5_000, 15_000, 30_000, 60_000]);
    expect(PEER_DC_UPGRADE_RETRY_TAIL_MS).toBe(120_000);
    const inner = defaultScheduler();
    let nowMs = inner.now();
    const queued: Array<{
      ms: number;
      resolve: () => void;
      reject: (err: unknown) => void;
      signal?: AbortSignal;
      onAbort: () => void;
    }> = [];
    const scheduler: MeshScheduler & { flushMs: (ms: number) => void } = {
      now: () => nowMs,
      interval: inner.interval.bind(inner),
      sleep(ms, signal) {
        if (signal?.aborted) {
          return Promise.reject(signal.reason ?? new Error('aborted'));
        }
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            const idx = queued.findIndex((row) => row.resolve === resolve);
            if (idx >= 0) queued.splice(idx, 1);
            reject(signal?.reason ?? new Error('aborted'));
          };
          queued.push({ ms, resolve, reject, signal, onAbort });
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
      flushMs(ms) {
        nowMs += ms;
        const rows = queued.filter((row) => row.ms === ms);
        for (const row of rows) {
          const idx = queued.indexOf(row);
          if (idx >= 0) queued.splice(idx, 1);
          row.signal?.removeEventListener('abort', row.onAbort);
          row.resolve();
        }
      },
    };
    const { small, large, managerSmall, managerLarge } = await setupDirectRtcPair(fixtures, {
      scheduler,
      now: () => nowMs,
    });
    await managerLarge.getLink(small.nodeId);
    await waitUntil(() => managerLarge.transportOf(small.nodeId) === 'dc', 5_000);
    await waitUntil(() => managerSmall.transportOf(large.nodeId) === 'dc', 5_000);

    managerLarge.getLive(small.nodeId)?.close('drop-dc');
    managerSmall.getLive(large.nodeId)?.close('drop-dc');
    await waitUntil(() => managerLarge.transportOf(small.nodeId) === null, 2_000);
    await waitUntil(() => managerSmall.transportOf(large.nodeId) === null, 2_000);

    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const [relayLarge, relaySmall] = createInMemoryLinkPair();
      echoQuiesceCaps(relaySmall);
      echoQuiesceCaps(relayLarge);
      expect(managerLarge.adoptLink(small.nodeId, relayLarge, 'relay', large.nodeId)).toBe(
        relayLarge
      );
      expect(managerSmall.adoptLink(large.nodeId, relaySmall, 'relay', large.nodeId)).toBe(
        relaySmall
      );
      await waitUntil(() => managerLarge.quiesceCapableOf(small.nodeId));
      await waitUntil(() => managerSmall.quiesceCapableOf(large.nodeId));
      expect(managerLarge.transportOf(small.nodeId)).toBe('relay');
      await waitUntil(
        () =>
          queued.some((row) => row.ms === PEER_DC_UPGRADE_RETRY_DELAYS_MS[0]) &&
          lines.some(
            (line) =>
              line.includes('[mesh][rtc] upgrade retry') &&
              line.includes(`peer=${small.nodeId}`) &&
              line.includes('attempt=1') &&
              line.includes(`in_ms=${PEER_DC_UPGRADE_RETRY_DELAYS_MS[0]}`)
          ),
        2_000
      );
      scheduler.flushMs(PEER_DC_UPGRADE_RETRY_DELAYS_MS[0]);
      await waitUntil(() => managerLarge.transportOf(small.nodeId) === 'dc', 5_000);
      await waitUntil(() => managerSmall.transportOf(large.nodeId) === 'dc', 5_000);
      expect(queued.some((row) => row.ms === PEER_DC_UPGRADE_RETRY_DELAYS_MS[1])).toBe(false);
    } finally {
      console.log = orig;
    }
  });

  test('peer node.status does not overwrite the peer_cache display name', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'studio',
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
    const [local, remote] = createInMemoryLinkPair();
    echoQuiesceCaps(remote);
    expect(manager.adoptLink(peer.nodeId, local, 'ws-secure', self.nodeId)).toBe(local);
    await waitUntil(() => manager.quiesceCapableOf(peer.nodeId));
    remote.ctl.send(
      encodeJsonBytes({
        t: 'node.status',
        name: 'production-db',
        endpoints: [],
        inventory: { version: '9.9.9' },
        direct_capable: true,
      })
    );
    await waitUntil(
      () => store.listPeers().find((row) => row.nodeId === peer.nodeId)?.directCapable === true
    );
    const cached = store.listPeers().find((row) => row.nodeId === peer.nodeId);
    expect(cached?.name).toBe('studio');
    expect(cached?.inventoryJson).toContain('9.9.9');
  });

  test('failed DC upgrade retry does not produce an unhandled rejection', async () => {
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
    let rejectIce: (err: Error) => void = () => {};
    const iceAttempt = new Promise<never>((_, reject) => {
      rejectIce = reject;
    });
    const rtc = {
      available: true,
      connectToPeer: () => iceAttempt,
    } as unknown as RtcPeerManager;
    const scheduler = new ImmediateScheduler();
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      rtc,
      scheduler,
    });
    fixtures.push({ close, stop: () => manager.stop() });

    const [dcLocal, dcRemote] = createInMemoryLinkPair();
    echoQuiesceCaps(dcRemote);
    expect(manager.adoptLink(peer.nodeId, dcLocal, 'dc', self.nodeId)).toBe(dcLocal);
    dcLocal.close('drop-dc');
    await waitUntil(() => manager.transportOf(peer.nodeId) === null);

    const [relayLocal, relayRemote] = createInMemoryLinkPair();
    echoQuiesceCaps(relayRemote);
    expect(manager.adoptLink(peer.nodeId, relayLocal, 'relay', self.nodeId)).toBe(relayLocal);
    await waitUntil(() => manager.quiesceCapableOf(peer.nodeId));
    await waitUntil(() => scheduler.sleeps > 0);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    const events = process as unknown as {
      on(event: string, listener: (reason: unknown) => void): void;
      off(event: string, listener: (reason: unknown) => void): void;
    };
    events.on('unhandledRejection', onUnhandled);
    try {
      relayLocal.close('drop-relay');
      await waitUntil(() => manager.transportOf(peer.nodeId) === null);
      rejectIce(new Error('ice-failed'));
      await Bun.sleep(30);
    } finally {
      events.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
