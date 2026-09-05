import { afterEach, describe, expect, test } from 'bun:test';
import { encodeBase64url, generateEd25519KeyPair, randomBytes } from '@tmex/shared/auth';
import { type LinkStream, createInMemoryLinkPair } from '@tmex/shared/link';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { defaultScheduler, encodeJsonBytes } from './ctl';
import {
  KEY_LOG_STATUS_DEBOUNCE_MS,
  PEER_CONNECT_TIMEOUT_MS,
  PEER_DC_UPGRADE_RETRY_DELAYS_MS,
  PEER_DC_UPGRADE_RETRY_TAIL_MS,
  PEER_MISSED_PONG_LIMIT,
  PEER_PING_INTERVAL_MS,
  PEER_RETIRE_MAX_MS,
  PEER_RETIRE_MIN_MS,
  PEER_RETIRE_QUIET_MS,
  PEER_RTC_WAKE_COOLDOWN_MS,
  PEER_RTC_WAKE_NONCE_CACHE,
  PEER_RTC_WAKE_VERIFY_BURST,
  PEER_RTC_WAKE_VERIFY_WINDOW_MS,
  PEER_UPGRADE_BACKOFF_CAP_MS,
  PEER_UPGRADE_COOLDOWN_MS,
  PEER_WS_DIAL_STAGGER_MS,
  PeerManager,
  winningDialInitiator,
} from './peer-manager';
import { handshakeRelay, handshakeWsDirect } from './peer-protocol';
import { dummyUplink, echoQuiesceCaps } from './peer-test-fixtures';
import type { RtcPeerManager } from './rtc';
import {
  encodeCandidateSignal,
  encodeRtcWakeSdp,
  encodeSdpSignal,
  peerRtcSession,
} from './rtc/ice';
import type { RtcLivenessOptions } from './rtc/rtc-peer-manager';
import { FakeClock } from './rtc/test-fakes';
import {
  ImmediateScheduler,
  fakeSocketPair,
  seedNodeIdentity,
  seedUser,
  waitUntil,
} from './test-support';
import { type MeshScheduler, NodeUnreachableError, type UplinkStatus } from './types';

function keysMatchInitiator(
  live: { sendKey: Uint8Array; recvKey: Uint8Array } | null,
  initiator: { sendKey?: Uint8Array; recvKey?: Uint8Array }
): boolean {
  return (
    live != null &&
    initiator.sendKey != null &&
    initiator.recvKey != null &&
    Buffer.from(live.sendKey).equals(Buffer.from(initiator.recvKey)) &&
    Buffer.from(live.recvKey).equals(Buffer.from(initiator.sendKey))
  );
}

async function openInitiatorWs(
  url: string,
  identity: { nodeId: string; edSecretKey: Uint8Array },
  store: UserStore
) {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws-error')), { once: true });
  });
  return handshakeWsDirect({
    socket: ws,
    role: 'initiator',
    identity,
    userStore: store,
  });
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

  test('inbound stream traffic keeps relay alive and missed-pong drains an in-flight stream', async () => {
    expect(PEER_PING_INTERVAL_MS * PEER_MISSED_PONG_LIMIT).toBe(15_000);
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
    const scheduler = new ImmediateScheduler();
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [local, remote] = createInMemoryLinkPair();
    expect(manager.adoptLink(peer.nodeId, local, 'relay', self.nodeId)).toBe(local);
    const incoming = new Promise<LinkStream>((resolve) => remote.onStream(resolve));
    const outbound = await local.openStream(new TextEncoder().encode('{"type":"keep"}'));
    const remoteStream = await incoming;

    for (let i = 0; i < PEER_MISSED_PONG_LIMIT + 1; i++) {
      await remoteStream.write(new Uint8Array([i]));
      scheduler.advance(PEER_PING_INTERVAL_MS);
      expect(manager.transportOf(peer.nodeId)).toBe('relay');
    }

    const localClosed = local.closed;
    let closed = false;
    void localClosed.then(() => {
      closed = true;
    });
    for (let i = 0; i < PEER_MISSED_PONG_LIMIT; i++) {
      scheduler.advance(PEER_PING_INTERVAL_MS);
    }
    expect(manager.transportOf(peer.nodeId)).toBeNull();
    await Promise.resolve();
    expect(closed).toBe(false);

    outbound.reset('done');
    await outbound.closed;
    scheduler.advance(PEER_RETIRE_MIN_MS);
    expect((await localClosed).reason).toBe('missed-pong');
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
    const [late] = fakeSocketPair();
    release?.(late);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(manager.listReach().get(peer.nodeId)).toBeNull();
    expect(late.closed).toBe(true);
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
    expect(manager.listReach().get(peer.nodeId)).toBe('wan');
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
        ready: async () => true,
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
        ready: async () => tryDc,
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
      endpointsJson: JSON.stringify(['ws://127.0.0.1:1/peer']),
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

  test('lazy native miss falls back without waking the peer', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1', { nodeId: new Uint8Array(16).fill(0xff) });
    const peer = seedNodeIdentity(store, 'user-1', { nodeId: new Uint8Array(16).fill(0x01) });
    let readyCalls = 0;
    let connectCalls = 0;
    let wakes = 0;
    const rtc = {
      available: true,
      async ready() {
        readyCalls += 1;
        return false;
      },
      async connectToPeer() {
        connectCalls += 1;
        throw new Error('node-datachannel is not available');
      },
    } as unknown as RtcPeerManager;
    const uplink = dummyUplink(self, store, async () => {
      throw new Error('relay unavailable');
    });
    uplink.sendCtl = (msg) => {
      if (msg.t === 'rtc.signal') wakes += 1;
    };
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink,
      peerPort: 0,
      startServer: false,
      rtc,
    });
    fixtures.push({ close, stop: () => manager.stop() });

    await expect(manager.getLink(peer.nodeId)).rejects.toBeInstanceOf(NodeUnreachableError);
    expect(readyCalls).toBe(1);
    expect(connectCalls).toBe(0);
    expect(wakes).toBe(0);
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

  test('offerer does not queue stale answers or candidates without an RTC attempt', async () => {
    const { small, large, managerSmall } = await setupDirectRtcPair(fixtures);
    const session = peerRtcSession(small.nodeId, large.nodeId);
    managerSmall.receiveRtcSignal(large.nodeId, {
      rtcSession: session,
      from: 'node',
      to: small.nodeId,
      sdp: encodeSdpSignal({ type: 'answer', sdp: 'v=0' }),
    });
    managerSmall.receiveRtcSignal(large.nodeId, {
      rtcSession: session,
      from: 'node',
      to: small.nodeId,
      candidate: encodeCandidateSignal('candidate:1', '0'),
    });
    const inbox = (
      managerSmall as unknown as { rtcInbox: Map<string, Array<{ receivedAt: number }>> }
    ).rtcInbox;
    expect(inbox.get(large.nodeId)).toBeUndefined();
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
      const detailLarge = managerLarge.linkDetailOf(small.nodeId);
      const detailSmall = managerSmall.linkDetailOf(large.nodeId);
      expect(
        detailLarge.dcBreaker.failures + detailSmall.dcBreaker.failures
      ).toBeGreaterThanOrEqual(1);
      expect(detailLarge.dcBreaker.failures).toBeLessThanOrEqual(1);
      const kind =
        detailLarge.dcBreaker.lastFailureKind ?? detailSmall.dcBreaker.lastFailureKind ?? '';
      expect(['liveness-timeout', 'channel-closed']).toContain(kind);
      expect(detailLarge.dcBreaker.cooling).toBe(false);
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
    const prevLevel = process.env.TMEX_LOG_LEVEL;
    process.env.TMEX_LOG_LEVEL = 'debug';
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
      if (prevLevel === undefined) delete process.env.TMEX_LOG_LEVEL;
      else process.env.TMEX_LOG_LEVEL = prevLevel;
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

  test('peer ctl async handlers log errors instead of unhandled rejection', async () => {
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
    store.upsertPeer = () => {
      throw new Error('upsert-fail');
    };
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      keyLogApplier: {
        async head() {
          return { seq: 0n, hash: new Uint8Array(32) };
        },
        async applyMany() {
          throw new Error('apply-fail');
        },
      },
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [local, remote] = createInMemoryLinkPair();
    echoQuiesceCaps(remote);
    expect(manager.adoptLink(peer.nodeId, local, 'ws-secure', self.nodeId)).toBe(local);
    await waitUntil(() => manager.quiesceCapableOf(peer.nodeId));

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    const events = process as unknown as {
      on(event: string, listener: (reason: unknown) => void): void;
      off(event: string, listener: (reason: unknown) => void): void;
    };
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    events.on('unhandledRejection', onUnhandled);
    try {
      remote.ctl.send(
        encodeJsonBytes({
          t: 'node.status',
          endpoints: [],
          inventory: {},
          direct_capable: true,
        })
      );
      remote.ctl.send(
        encodeJsonBytes({
          t: 'key.log.res',
          records: [{ seq: 1, bytes: 'AAAA', sig: 'AAAA' }],
        })
      );
      await Bun.sleep(50);
    } finally {
      events.off('unhandledRejection', onUnhandled);
      console.log = origLog;
    }
    expect(unhandled).toEqual([]);
    expect(logs.some((line) => line.includes('ctl failed') && line.includes('upsert-fail'))).toBe(
      true
    );
    expect(logs.some((line) => line.includes('ctl failed') && line.includes('apply-fail'))).toBe(
      true
    );
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
      ready: async () => true,
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

  function hangingRtc(): {
    rtc: RtcPeerManager;
    fail: (err?: Error) => void;
    attempts: () => number;
  } {
    let attempts = 0;
    const waiters: Array<(err: Error) => void> = [];
    const rtc = {
      available: true,
      ready: async () => true,
      connectToPeer: () => {
        attempts += 1;
        return new Promise<never>((_, reject) => {
          waiters.push(reject);
        });
      },
    } as unknown as RtcPeerManager;
    return {
      rtc,
      fail(err = new Error('dc-handshake-failed')) {
        for (const reject of waiters.splice(0)) reject(err);
      },
      attempts: () => attempts,
    };
  }

  async function adoptQuiesced(
    manager: PeerManager,
    peerNodeId: string,
    session: import('@tmex/shared/link').LinkSession,
    remote: import('@tmex/shared/link').LinkSession,
    transport: 'relay' | 'ws-secure' | 'dc',
    initiatedBy: string
  ): Promise<void> {
    echoQuiesceCaps(remote);
    expect(manager.adoptLink(peerNodeId, session, transport, initiatedBy)).toBe(session);
    await waitUntil(() => manager.quiesceCapableOf(peerNodeId));
  }

  test('getLink returns the live established link immediately during an in-flight DC upgrade', async () => {
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
    const hanging = hangingRtc();
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store, async () => {
        throw new Error('no-relay');
      }),
      peerPort: 0,
      startServer: false,
      rtc: hanging.rtc,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [relayLocal, relayRemote] = createInMemoryLinkPair();
    await adoptQuiesced(manager, peer.nodeId, relayLocal, relayRemote, 'relay', self.nodeId);

    const first = await manager.getLink(peer.nodeId);
    expect(first).toBe(relayLocal);
    await waitUntil(() => hanging.attempts() >= 1, 2_000);

    const t0 = performance.now();
    const again = await manager.getLink(peer.nodeId);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(again).toBe(relayLocal);
    expect(manager.transportOf(peer.nodeId)).toBe('relay');
  });

  test('transportOf never reports dc while a DC handshake is still in flight', async () => {
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
    const hanging = hangingRtc();
    const seen: Array<string | null> = [];
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store, async () => {
        throw new Error('no-relay');
      }),
      peerPort: 0,
      startServer: false,
      rtc: hanging.rtc,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [relayLocal, relayRemote] = createInMemoryLinkPair();
    await adoptQuiesced(manager, peer.nodeId, relayLocal, relayRemote, 'relay', self.nodeId);
    void manager.getLink(peer.nodeId);
    await waitUntil(() => hanging.attempts() >= 1, 2_000);
    for (let i = 0; i < 20; i++) {
      seen.push(manager.transportOf(peer.nodeId));
      await Bun.sleep(5);
    }
    expect(seen.every((kind) => kind === 'relay')).toBe(true);
    expect(seen.includes('dc')).toBe(false);
  });

  test('a stream opened during a failing DC upgrade stays on the established link', async () => {
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
    const hanging = hangingRtc();
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store, async () => {
        throw new Error('no-relay');
      }),
      peerPort: 0,
      startServer: false,
      rtc: hanging.rtc,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [relayLocal, relayRemote] = createInMemoryLinkPair();
    await adoptQuiesced(manager, peer.nodeId, relayLocal, relayRemote, 'relay', self.nodeId);
    const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      relayRemote.onStream(resolve)
    );
    void manager.getLink(peer.nodeId);
    await waitUntil(() => hanging.attempts() >= 1, 2_000);

    const link = await manager.getLink(peer.nodeId);
    expect(link).toBe(relayLocal);
    const outbound = await link.openStream(new TextEncoder().encode('{"type":"keep"}'));
    const inbound = await incomingP;
    await outbound.write(new TextEncoder().encode('before-fail'));
    hanging.fail(new Error('ice-timeout'));
    await Bun.sleep(30);
    expect(manager.transportOf(peer.nodeId)).toBe('relay');
    await outbound.write(new TextEncoder().encode('after-fail'));
    await outbound.end();
    const reader = inbound.readable.getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(new TextDecoder().decode(value.bytes));
    }
    expect(chunks.join('')).toBe('before-failafter-fail');
    inbound.end();
  });

  test('after DC loss with relay alive, getLink never binds a stream to a DC dial that fails after 5s', async () => {
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
    let rejectDial: (err: Error) => void = () => {};
    let dials = 0;
    const rtc = {
      available: true,
      ready: async () => true,
      connectToPeer: () => {
        dials += 1;
        return new Promise<never>((_, reject) => {
          rejectDial = reject;
        });
      },
    } as unknown as RtcPeerManager;
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store, async () => {
        throw new Error('no-relay');
      }),
      peerPort: 0,
      startServer: false,
      rtc,
    });
    fixtures.push({ close, stop: () => manager.stop() });

    const [dcLocal, dcRemote] = createInMemoryLinkPair();
    await adoptQuiesced(manager, peer.nodeId, dcLocal, dcRemote, 'dc', self.nodeId);
    dcLocal.close('drop-dc');
    await waitUntil(() => manager.transportOf(peer.nodeId) === null);

    const [relayLocal, relayRemote] = createInMemoryLinkPair();
    const boundSessions: import('@tmex/shared/link').LinkSession[] = [];
    const origOpen = relayLocal.openStream.bind(relayLocal);
    relayLocal.openStream = async (payload) => {
      boundSessions.push(relayLocal);
      return origOpen(payload);
    };
    await adoptQuiesced(manager, peer.nodeId, relayLocal, relayRemote, 'relay', self.nodeId);

    const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      relayRemote.onStream(resolve)
    );
    const t0 = performance.now();
    const link = await manager.getLink(peer.nodeId);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(link).toBe(relayLocal);
    expect(manager.transportOf(peer.nodeId)).toBe('relay');

    const outbound = await link.openStream(new TextEncoder().encode('{"type":"http"}'));
    expect(boundSessions).toEqual([relayLocal]);
    const inbound = await incomingP;
    await outbound.write(new TextEncoder().encode('payload'));
    await waitUntil(() => dials >= 1, 2_000);
    for (let i = 0; i < 10; i++) {
      expect(manager.transportOf(peer.nodeId)).toBe('relay');
      await Bun.sleep(10);
    }
    await Bun.sleep(50);
    rejectDial(new Error('dc-handshake-failed-after-5s'));
    await Bun.sleep(30);
    expect(manager.transportOf(peer.nodeId)).toBe('relay');
    await outbound.write(new TextEncoder().encode('-ok'));
    await outbound.end();
    const reader = inbound.readable.getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(new TextDecoder().decode(value.bytes));
    }
    expect(chunks.join('')).toBe('payload-ok');
    expect(await manager.getLink(peer.nodeId)).toBe(relayLocal);
    inbound.end();
  });

  test('getLink waiting on a DC-first dial returns as soon as a live fallback is established', async () => {
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
    const hanging = hangingRtc();
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store, async () => {
        throw new Error('no-relay');
      }),
      peerPort: 0,
      startServer: false,
      rtc: hanging.rtc,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const pending = manager.getLink(peer.nodeId);
    await waitUntil(() => hanging.attempts() >= 1, 2_000);
    const [relayLocal, relayRemote] = createInMemoryLinkPair();
    echoQuiesceCaps(relayRemote);
    expect(manager.adoptLink(peer.nodeId, relayLocal, 'relay', self.nodeId)).toBe(relayLocal);
    const link = await Promise.race([
      pending,
      Bun.sleep(200).then(() => {
        throw new Error('getLink kept waiting for DC after a live relay existed');
      }),
    ]);
    expect(link).toBe(relayLocal);
    expect(manager.transportOf(peer.nodeId)).toBe('relay');
  });

  test('after DC death getLink uses a fallback without waiting for a hanging DC re-dial', async () => {
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
    const hanging = hangingRtc();
    const [wsLocal, wsRemote] = createInMemoryLinkPair();
    fixtures.push({ close: () => wsRemote.close('test') });
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store, async () => {
        throw new Error('no-relay');
      }),
      peerPort: 0,
      startServer: false,
      rtc: hanging.rtc,
      linkFactory: async () => wsLocal,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [dcLocal, dcRemote] = createInMemoryLinkPair();
    await adoptQuiesced(manager, peer.nodeId, dcLocal, dcRemote, 'dc', self.nodeId);
    dcLocal.close('drop-dc');
    await waitUntil(() => manager.transportOf(peer.nodeId) === null, 2_000);

    const t0 = performance.now();
    const link = await manager.getLink(peer.nodeId);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(link).toBe(wsLocal);
    expect(manager.transportOf(peer.nodeId)).toBe('ws-secure');
  });

  test('DC loss promotes a still-open retiring fallback so getLink does not wait on DC', async () => {
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
    const hanging = hangingRtc();
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store, async () => {
        throw new Error('no-relay');
      }),
      peerPort: 0,
      startServer: false,
      rtc: hanging.rtc,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [relayLocal, relayRemote] = createInMemoryLinkPair();
    await adoptQuiesced(manager, peer.nodeId, relayLocal, relayRemote, 'relay', self.nodeId);
    const [dcLocal, dcRemote] = createInMemoryLinkPair();
    echoQuiesceCaps(dcRemote);
    expect(manager.adoptLink(peer.nodeId, dcLocal, 'dc', self.nodeId)).toBe(dcLocal);
    expect(manager.transportOf(peer.nodeId)).toBe('dc');
    dcLocal.close('drop-dc');
    await waitUntil(() => manager.transportOf(peer.nodeId) !== 'dc', 2_000);

    const t0 = performance.now();
    const link = await manager.getLink(peer.nodeId);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(link).toBe(relayLocal);
    expect(manager.transportOf(peer.nodeId)).toBe('relay');
  });

  test('adoptLink classifies reach from remote address; missing address is wan', async () => {
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
    const [lanA] = createInMemoryLinkPair();
    expect(manager.adoptLink(peer.nodeId, lanA, 'ws-secure', self.nodeId, '10.0.0.8')).toBe(lanA);
    expect(manager.listReach().get(peer.nodeId)).toBe('lan');
    expect(manager.rttOf(peer.nodeId)).toBeNull();
    lanA.close();
    await waitUntil(() => manager.listReach().get(peer.nodeId) == null);

    const [wanA] = createInMemoryLinkPair();
    expect(manager.adoptLink(peer.nodeId, wanA, 'ws-secure', self.nodeId, '203.0.113.10')).toBe(
      wanA
    );
    expect(manager.listReach().get(peer.nodeId)).toBe('wan');
    wanA.close();
    await waitUntil(() => manager.listReach().get(peer.nodeId) == null);

    const [unknownA] = createInMemoryLinkPair();
    expect(manager.adoptLink(peer.nodeId, unknownA, 'ws-secure', self.nodeId)).toBe(unknownA);
    expect(manager.listReach().get(peer.nodeId)).toBe('wan');
  });

  test('ping/pong records rttMs and resets it on transport switch', async () => {
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
    store.upsertPeer({
      nodeId: self.nodeId,
      name: 'self',
      endpointsJson: '[]',
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const scheduler = new ImmediateScheduler();
    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler,
    });
    const managerB = new PeerManager({
      identity: peer,
      userStore: store,
      uplink: dummyUplink(peer, store),
      peerPort: 0,
      startServer: false,
      scheduler,
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    fixtures.push({ close, stop: () => managerB.stop() });
    const [a, b] = createInMemoryLinkPair();
    expect(managerA.adoptLink(peer.nodeId, a, 'relay', self.nodeId)).toBe(a);
    expect(managerB.adoptLink(self.nodeId, b, 'relay', self.nodeId)).toBe(b);
    expect(managerA.rttOf(peer.nodeId)).toBeNull();
    scheduler.tickIntervals();
    await waitUntil(() => managerA.rttOf(peer.nodeId) != null);
    expect(managerA.rttOf(peer.nodeId)).toBeGreaterThanOrEqual(0);
    const [wsA, wsB] = createInMemoryLinkPair();
    expect(managerA.adoptLink(peer.nodeId, wsA, 'ws-secure', self.nodeId, '10.1.2.3')).toBe(wsA);
    expect(managerB.adoptLink(self.nodeId, wsB, 'ws-secure', self.nodeId, '10.1.2.3')).toBe(wsB);
    expect(managerA.listReach().get(peer.nodeId)).toBe('lan');
    expect(managerA.rttOf(peer.nodeId)).toBeNull();
  });

  test('dropping a dc link with a parked ws-secure fallback emits one lan/wan link info and never null', async () => {
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
    store.upsertPeer({
      nodeId: self.nodeId,
      name: 'self',
      endpointsJson: '[]',
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const infos: Array<{
      nodeId: string;
      reach: 'lan' | 'wan' | 'relay' | null;
      transport: string | null;
      rttMs: number | null;
    }> = [];
    const scheduler = new ImmediateScheduler();
    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler,
      onLinkInfo: (info) => infos.push({ ...info }),
    });
    const managerB = new PeerManager({
      identity: peer,
      userStore: store,
      uplink: dummyUplink(peer, store),
      peerPort: 0,
      startServer: false,
      scheduler,
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    fixtures.push({ close, stop: () => managerB.stop() });
    const [wsA, wsB] = createInMemoryLinkPair();
    echoQuiesceCaps(wsB);
    expect(managerA.adoptLink(peer.nodeId, wsA, 'ws-secure', self.nodeId, '10.0.0.8')).toBe(wsA);
    expect(managerB.adoptLink(self.nodeId, wsB, 'ws-secure', self.nodeId, '10.0.0.8')).toBe(wsB);
    await waitUntil(() => managerA.quiesceCapableOf(peer.nodeId));
    scheduler.tickIntervals();
    await waitUntil(() => managerA.rttOf(peer.nodeId) != null);
    expect(managerA.rttOf(peer.nodeId)).toBeGreaterThanOrEqual(0);

    const [dcA, dcB] = createInMemoryLinkPair();
    echoQuiesceCaps(dcB);
    expect(managerA.adoptLink(peer.nodeId, dcA, 'dc', self.nodeId, '10.0.0.8')).toBe(dcA);
    expect(managerA.transportOf(peer.nodeId)).toBe('dc');
    expect(managerA.rttOf(peer.nodeId)).toBeNull();

    const watermark = infos.length;
    dcA.close('drop-dc');
    await waitUntil(() => managerA.transportOf(peer.nodeId) === 'ws-secure');
    const post = infos.slice(watermark);
    expect(post.map((row) => row.reach)).not.toContain(null);
    expect(post).toHaveLength(1);
    expect(post[0]?.reach).toBe('lan');
    expect(post[0]?.transport).toBe('ws-secure');
    expect(post[0]?.rttMs).toBeNull();
    expect(managerA.rttOf(peer.nodeId)).toBeNull();
    expect(managerA.listReach().get(peer.nodeId)).toBe('lan');
  });

  test('dropping a live link with a parked ws-secure inbound emits one lan/wan link info and never null', async () => {
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
    const infos: Array<{
      nodeId: string;
      reach: 'lan' | 'wan' | 'relay' | null;
      transport: string | null;
      rttMs: number | null;
    }> = [];
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      onLinkInfo: (info) => infos.push({ ...info }),
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [liveA, liveB] = createInMemoryLinkPair();
    fixtures.push({ close: () => liveB.close('test') });
    expect(manager.adoptLink(peer.nodeId, liveA, 'relay', self.nodeId)).toBe(liveA);
    const [parkA, parkB] = createInMemoryLinkPair();
    fixtures.push({ close: () => parkB.close('test') });
    expect(manager.adoptLink(peer.nodeId, parkA, 'ws-secure', peer.nodeId, '203.0.113.10')).toBe(
      liveA
    );
    expect(manager.transportOf(peer.nodeId)).toBe('relay');

    const watermark = infos.length;
    liveA.close('drop-live');
    await waitUntil(() => manager.transportOf(peer.nodeId) === 'ws-secure');
    const post = infos.slice(watermark);
    expect(post.map((row) => row.reach)).not.toContain(null);
    expect(post).toHaveLength(1);
    expect(post[0]?.reach).toBe('wan');
    expect(post[0]?.transport).toBe('ws-secure');
    expect(post[0]?.rttMs).toBeNull();
    expect(manager.rttOf(peer.nodeId)).toBeNull();
  });

  test('dropping the last live link emits a single null reach', async () => {
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
    const infos: Array<{
      nodeId: string;
      reach: 'lan' | 'wan' | 'relay' | null;
      transport: string | null;
      rttMs: number | null;
    }> = [];
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      onLinkInfo: (info) => infos.push({ ...info }),
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [local] = createInMemoryLinkPair();
    expect(manager.adoptLink(peer.nodeId, local, 'dc', self.nodeId, '10.0.0.8')).toBe(local);
    expect(manager.listReach().get(peer.nodeId)).toBe('lan');
    const watermark = infos.length;
    local.close('drop-last');
    await waitUntil(() => manager.listReach().get(peer.nodeId) == null);
    const post = infos.slice(watermark);
    expect(post).toHaveLength(1);
    expect(post[0]?.reach).toBeNull();
    expect(post[0]?.transport).toBeNull();
    expect(post[0]?.rttMs).toBeNull();
  });

  test('node.status upserts when projection changes and skips upgrade when unchanged', async () => {
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
      lastSeenAt: 1,
      listVersion: 1,
    });
    const scheduler = new ImmediateScheduler();
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [local, remote] = createInMemoryLinkPair();
    echoQuiesceCaps(remote);
    expect(manager.adoptLink(peer.nodeId, local, 'ws-secure', self.nodeId)).toBe(local);
    await waitUntil(() => manager.quiesceCapableOf(peer.nodeId));

    let upserts = 0;
    let upgrades = 0;
    const origUpsert = store.upsertPeer.bind(store);
    store.upsertPeer = (input) => {
      upserts += 1;
      origUpsert(input);
    };
    const origNotify = manager.notifyPeerEndpointsChanged.bind(manager);
    manager.notifyPeerEndpointsChanged = (nodeId?: string) => {
      upgrades += 1;
      origNotify(nodeId);
    };

    const status = {
      t: 'node.status',
      endpoints: ['ws://10.0.0.9:39001/peer'],
      inventory: { version: '1.0.0' },
      direct_capable: true,
    };
    remote.ctl.send(encodeJsonBytes(status));
    await waitUntil(() => store.getPeer(peer.nodeId)?.directCapable === true);
    expect(upserts).toBe(1);
    expect(upgrades).toBe(1);
    const afterChange = store.getPeer(peer.nodeId);
    expect(afterChange?.inventoryJson).toContain('1.0.0');
    expect(afterChange?.lastSeenAt).toBe(scheduler.nowMs);

    scheduler.nowMs += 50;
    upserts = 0;
    upgrades = 0;
    remote.ctl.send(encodeJsonBytes(status));
    await waitUntil(() => store.getPeer(peer.nodeId)?.lastSeenAt === scheduler.nowMs);
    expect(upserts).toBe(0);
    expect(upgrades).toBe(0);
    const afterSame = store.getPeer(peer.nodeId);
    expect(afterSame?.endpointsJson).toBe(afterChange?.endpointsJson);
    expect(afterSame?.inventoryJson).toBe(afterChange?.inventoryJson);
    expect(afterSame?.directCapable).toBe(true);
    expect(afterSame?.lastSeenAt).toBe(scheduler.nowMs);
  });

  test('idle deadline is a one-shot idleMs timer', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const scheduler = new ImmediateScheduler();
    const idleMs = 5_123;
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      idleMs,
      scheduler,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [local] = createInMemoryLinkPair();
    expect(manager.adoptLink(peer.nodeId, local, 'relay', self.nodeId)).toBe(local);
    const idleTimers = scheduler.intervals.filter((row) => !row.cleared && row.ms === idleMs);
    expect(idleTimers).toHaveLength(1);
    expect(scheduler.intervals.some((row) => !row.cleared && row.ms === 1_000)).toBe(false);
    scheduler.advance(idleMs - 1);
    expect(manager.listReach().get(peer.nodeId)).toBe('relay');
    scheduler.advance(1);
    await waitUntil(() => manager.listReach().get(peer.nodeId) !== 'relay');
  });

  test('idle deadline re-arms from stream activity', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const scheduler = new ImmediateScheduler();
    const idleMs = 5_000;
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      idleMs,
      scheduler,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [local] = createInMemoryLinkPair();
    expect(manager.adoptLink(peer.nodeId, local, 'relay', self.nodeId)).toBe(local);
    scheduler.advance(3_000);
    const stream = await local.openStream(new TextEncoder().encode('{"type":"keep"}'));
    stream.reset('done');
    await stream.closed;
    scheduler.advance(2_000);
    expect(manager.listReach().get(peer.nodeId)).toBe('relay');
    scheduler.advance(3_000);
    await waitUntil(() => manager.listReach().get(peer.nodeId) !== 'relay');
  });

  test('parked inbound uses a one-shot max deadline', async () => {
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
    const scheduler = new ImmediateScheduler();
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [liveA, liveB] = createInMemoryLinkPair();
    fixtures.push({ close: () => liveB.close('test') });
    expect(manager.adoptLink(peer.nodeId, liveA, 'relay', self.nodeId)).toBe(liveA);
    const [parkA, parkB] = createInMemoryLinkPair();
    fixtures.push({ close: () => parkB.close('test') });
    expect(manager.adoptLink(peer.nodeId, parkA, 'ws-secure', peer.nodeId, '203.0.113.10')).toBe(
      liveA
    );
    const parkTimers = scheduler.intervals.filter(
      (row) => !row.cleared && row.ms === PEER_RETIRE_MAX_MS
    );
    expect(parkTimers).toHaveLength(1);
    const parkedClosed = parkA.closed;
    scheduler.advance(PEER_RETIRE_MAX_MS - 1);
    expect(manager.transportOf(peer.nodeId)).toBe('relay');
    scheduler.advance(1);
    expect((await parkedClosed).reason).toBe('park-timeout');
    expect(manager.transportOf(peer.nodeId)).toBe('relay');
  });

  test('retiring peer finishes on the min deadline when quiet', async () => {
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
    const scheduler = new ImmediateScheduler();
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [liveA, liveB] = createInMemoryLinkPair();
    echoQuiesceCaps(liveB);
    expect(manager.adoptLink(peer.nodeId, liveA, 'ws-secure', self.nodeId)).toBe(liveA);
    await waitUntil(() => manager.quiesceCapableOf(peer.nodeId));
    const [nextA, nextB] = createInMemoryLinkPair();
    fixtures.push({ close: () => nextB.close('test') });
    echoQuiesceCaps(nextB);
    const retired = liveA.closed;
    const timersBeforeRetire = scheduler.intervals.filter(
      (row) => !row.cleared && row.ms === PEER_RETIRE_MIN_MS
    ).length;
    expect(manager.adoptLink(peer.nodeId, nextA, 'dc', self.nodeId, '10.0.0.8')).toBe(nextA);
    const retireTimers = scheduler.intervals.filter(
      (row) => !row.cleared && row.ms === PEER_RETIRE_MIN_MS
    );
    expect(retireTimers).toHaveLength(timersBeforeRetire + 1);
    scheduler.advance(PEER_RETIRE_MIN_MS - 1);
    let done = false;
    void retired.then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    scheduler.advance(1);
    expect((await retired).reason).toBe('replaced');
  });

  test('retiring peer waits the quiet window after streams drain past min', async () => {
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
    const scheduler = new ImmediateScheduler();
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [liveA, liveB] = createInMemoryLinkPair();
    echoQuiesceCaps(liveB);
    expect(manager.adoptLink(peer.nodeId, liveA, 'ws-secure', self.nodeId)).toBe(liveA);
    await waitUntil(() => manager.quiesceCapableOf(peer.nodeId));
    const stream = await liveA.openStream(new TextEncoder().encode('{"type":"keep"}'));
    const [nextA, nextB] = createInMemoryLinkPair();
    fixtures.push({ close: () => nextB.close('test') });
    echoQuiesceCaps(nextB);
    const retired = liveA.closed;
    expect(manager.adoptLink(peer.nodeId, nextA, 'dc', self.nodeId, '10.0.0.8')).toBe(nextA);
    scheduler.advance(PEER_RETIRE_MIN_MS);
    let done = false;
    void retired.then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    stream.reset('done');
    await stream.closed;
    scheduler.advance(PEER_RETIRE_QUIET_MS - 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    scheduler.advance(1);
    expect((await retired).reason).toBe('replaced');
  });

  test('retiring peer finishes on the max deadline when quiet would be later', async () => {
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
    const scheduler = new ImmediateScheduler();
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [liveA, liveB] = createInMemoryLinkPair();
    echoQuiesceCaps(liveB);
    expect(manager.adoptLink(peer.nodeId, liveA, 'ws-secure', self.nodeId)).toBe(liveA);
    await waitUntil(() => manager.quiesceCapableOf(peer.nodeId));
    const stream = await liveA.openStream(new TextEncoder().encode('{"type":"keep"}'));
    const [nextA, nextB] = createInMemoryLinkPair();
    fixtures.push({ close: () => nextB.close('test') });
    echoQuiesceCaps(nextB);
    const retired = liveA.closed;
    expect(manager.adoptLink(peer.nodeId, nextA, 'dc', self.nodeId, '10.0.0.8')).toBe(nextA);
    scheduler.advance(PEER_RETIRE_MAX_MS - PEER_RETIRE_QUIET_MS + 1);
    stream.reset('done');
    await stream.closed;
    let done = false;
    void retired.then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    scheduler.advance(PEER_RETIRE_QUIET_MS - 2);
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    scheduler.advance(1);
    expect((await retired).reason).toBe('replaced');
  });

  test('retiring peer finishes immediately after mutual quiesce acks', async () => {
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
    const [liveA, liveB] = createInMemoryLinkPair();
    echoQuiesceCaps(liveB);
    expect(manager.adoptLink(peer.nodeId, liveA, 'ws-secure', self.nodeId)).toBe(liveA);
    await waitUntil(() => manager.quiesceCapableOf(peer.nodeId));
    const [nextA, nextB] = createInMemoryLinkPair();
    fixtures.push({ close: () => nextB.close('test') });
    echoQuiesceCaps(nextB);
    const retired = liveA.closed;
    expect(manager.adoptLink(peer.nodeId, nextA, 'dc', self.nodeId, '10.0.0.8')).toBe(nextA);
    liveB.ctl.send(encodeJsonBytes({ t: 'link.quiesce.ack' }));
    liveB.ctl.send(encodeJsonBytes({ t: 'link.quiesce' }));
    expect((await retired).reason).toBe('replaced');
  });

  test('key-log append broadcasts node.status with the new head', async () => {
    const { manager, scheduler, statuses, head } = await setupStatusPeer(fixtures);
    await waitUntil(() => statuses.some((row) => row.t === 'node.status'));
    expect(statuses.filter((row) => row.t === 'node.status')).toHaveLength(1);
    head.seq = 4n;
    head.hash = new Uint8Array(32).fill(4);
    manager.notifyKeyLogHeadChanged();
    scheduler.advance(KEY_LOG_STATUS_DEBOUNCE_MS);
    await waitUntil(() => statuses.filter((row) => row.t === 'node.status').length === 2);
    const latest = statuses.filter((row) => row.t === 'node.status').at(-1);
    expect(latest?.key_log_head).toEqual({
      seq: 4,
      hash: encodeBase64url(head.hash),
    });
  });

  test('key-log append bursts coalesce into one status broadcast', async () => {
    const { manager, scheduler, statuses, head } = await setupStatusPeer(fixtures);
    await waitUntil(() => statuses.some((row) => row.t === 'node.status'));
    head.seq = 5n;
    head.hash = new Uint8Array(32).fill(5);
    manager.notifyKeyLogHeadChanged();
    manager.notifyKeyLogHeadChanged();
    manager.notifyKeyLogHeadChanged();
    expect(statuses.filter((row) => row.t === 'node.status')).toHaveLength(1);
    scheduler.advance(KEY_LOG_STATUS_DEBOUNCE_MS);
    await waitUntil(() => statuses.filter((row) => row.t === 'node.status').length === 2);
    expect(statuses.filter((row) => row.t === 'node.status')).toHaveLength(2);
  });

  test('unchanged advertised status including key-log head is skipped', async () => {
    const { manager, statuses } = await setupStatusPeer(fixtures);
    await waitUntil(() => statuses.some((row) => row.t === 'node.status'));
    manager.refreshAdvertisedStatus();
    await Bun.sleep(20);
    expect(statuses.filter((row) => row.t === 'node.status')).toHaveLength(1);
  });

  test('key-log head is cached across ads until notifyKeyLogHeadChanged', async () => {
    const { manager, scheduler, statuses, head, headCalls } = await setupStatusPeer(fixtures);
    await waitUntil(() => statuses.some((row) => row.t === 'node.status'));
    expect(headCalls()).toBe(1);
    manager.refreshAdvertisedStatus();
    await Bun.sleep(20);
    expect(headCalls()).toBe(1);
    expect(statuses.filter((row) => row.t === 'node.status')).toHaveLength(1);
    head.seq = 9n;
    head.hash = new Uint8Array(32).fill(9);
    manager.notifyKeyLogHeadChanged();
    scheduler.advance(KEY_LOG_STATUS_DEBOUNCE_MS);
    await waitUntil(() => statuses.filter((row) => row.t === 'node.status').length === 2);
    expect(headCalls()).toBe(2);
    const latest = statuses.filter((row) => row.t === 'node.status').at(-1);
    expect(latest?.key_log_head).toEqual({
      seq: 9,
      hash: encodeBase64url(head.hash),
    });
  });

  test('fingerprint change refreshes cached interfaces before advertising status', async () => {
    const { db, close } = createMigratedAuthDb();
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
    let generation = 1;
    const v1 = { en0: [{ address: '10.0.0.8', family: 'IPv4', internal: false }] };
    const v2 = { en0: [{ address: '10.0.0.9', family: 'IPv4', internal: false }] };
    let cached: typeof v1 | typeof v2 | null = null;
    const refresh = () => {
      cached = generation === 1 ? v1 : v2;
      return cached;
    };
    const get = () => cached ?? refresh();
    const scheduler = new ImmediateScheduler();
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler,
      refreshLocalInterfaces: refresh,
      interfacesFn: get,
      statusProvider: (): UplinkStatus => {
        const ifaces = get();
        const address = ifaces.en0?.[0]?.address ?? 'none';
        return {
          version: '1',
          tmux: false,
          direct_capable: false,
          inventory: {},
          endpoints: [`ws://${address}:1/peer`],
        };
      },
    });
    fixtures.push({ close, stop: () => manager.stop() });
    await manager.start();
    const [local, remote] = createInMemoryLinkPair();
    const statuses: Array<Record<string, unknown>> = [];
    remote.ctl.onMessage((bytes) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        if (msg.t === 'node.status') statuses.push(msg);
      } catch {
        /* ignore */
      }
    });
    echoQuiesceCaps(remote);
    expect(manager.adoptLink(peer.nodeId, local, 'ws-secure', self.nodeId)).toBe(local);
    await waitUntil(() => statuses.some((row) => row.t === 'node.status'));
    expect(statuses.at(-1)?.endpoints).toEqual(['ws://10.0.0.8:1/peer']);
    generation = 2;
    scheduler.tickIntervals();
    await waitUntil(
      () => statuses.some((row) => JSON.stringify(row.endpoints).includes('10.0.0.9')),
      2_000
    );
    expect(statuses.at(-1)?.endpoints).toEqual(['ws://10.0.0.9:1/peer']);
  });

  test('ws-secure races ranked endpoints: hanging first loses to a later success', async () => {
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
    const goodPort = managerA.listenPort;
    expect(goodPort).toBeGreaterThan(0);
    let hangAccepted = 0;
    let hangClosed = 0;
    const hangServer = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open() {
          hangAccepted += 1;
        },
        data() {},
        close() {
          hangClosed += 1;
        },
        error() {},
      },
    });
    fixtures.push({ close: () => hangServer.stop(true) });
    store.upsertPeer({
      nodeId: self.nodeId,
      name: 'self',
      endpointsJson: JSON.stringify([
        `ws://127.0.0.1:${hangServer.port}/peer`,
        `ws://127.0.0.1:${goodPort}/peer`,
      ]),
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
      hubHost: 'hub.example.com',
    });
    fixtures.push({ close, stop: () => managerB.stop() });
    const t0 = performance.now();
    const link = await managerB.getLink(self.nodeId);
    const elapsed = performance.now() - t0;
    expect(link).toBeTruthy();
    expect(managerB.transportOf(self.nodeId)).toBe('ws-secure');
    expect(elapsed).toBeLessThan(PEER_CONNECT_TIMEOUT_MS);
    expect(elapsed).toBeLessThan(PEER_WS_DIAL_STAGGER_MS + 1_200);
    await waitUntil(() => hangClosed >= hangAccepted && hangAccepted >= 1, 2_000);
    expect(hangAccepted).toBeGreaterThanOrEqual(1);
    expect(hangClosed).toBeGreaterThanOrEqual(hangAccepted);
    const detail = managerB.linkDetailOf(self.nodeId);
    expect(detail.directFailure).toBeNull();
    expect(detail.peerAddress).toBe('127.0.0.1');
    expect(detail.linkSinceAt).toBeGreaterThan(0);
    expect(detail.endpoints).toEqual([]);
  });

  test('all ws-secure endpoints failing still falls back to relay', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify(['ws://127.0.0.1:1/peer', 'ws://127.0.0.1:2/peer']),
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
      hubHost: 'hub.example.com',
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
    const detail = manager.linkDetailOf(peer.nodeId);
    expect(detail.peerAddress).toBe('hub.example.com');
    expect(detail.linkSinceAt).toBeGreaterThan(0);
    expect(detail.directFailure?.dc).toBe('direct_capable=false');
    expect(detail.directFailure?.ws).toMatch(/127\.0\.0\.1:[12]/);
    expect(detail.endpoints).toEqual([]);
    link.close();
  });

  test('relay diagnostics follow a hubHost getter, not a captured config host', async () => {
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
    let host = 'old.example.com';
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink,
      peerPort: 0,
      startServer: false,
      connectTimeoutMs: 200,
      hubHost: () => host,
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
    host = 'new.example.com';
    expect(manager.linkDetailOf(peer.nodeId).peerAddress).toBe('new.example.com');
    link.close();
  });

  test('stop during a ws-secure race aborts every in-flight attempt', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    let hangAccepted = 0;
    let hangClosed = 0;
    const hangServer = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open() {
          hangAccepted += 1;
        },
        data() {},
        close() {
          hangClosed += 1;
        },
        error() {},
      },
    });
    fixtures.push({ close: () => hangServer.stop(true) });
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify([
        `ws://127.0.0.1:${hangServer.port}/peer`,
        `ws://127.0.0.1:${hangServer.port}/peer`,
      ]),
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
    const pending = manager.getLink(peer.nodeId);
    await waitUntil(() => hangAccepted >= 1, 2_000);
    await manager.stop();
    await expect(pending).rejects.toBeInstanceOf(NodeUnreachableError);
    await waitUntil(() => hangClosed >= hangAccepted, 2_000);
    expect(hangClosed).toBeGreaterThanOrEqual(hangAccepted);
  });

  test('same-turn ws-secure handshakes track and key only the race winner', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify(['ws://127.0.0.1:1/peer', 'ws://127.0.0.1:2/peer']),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const resolvers: Array<(ws: ReturnType<typeof fakeSocketPair>[0]) => void> = [];
    const clients: Array<ReturnType<typeof fakeSocketPair>[0]> = [];
    const acceptors: Array<{
      sendKey?: Uint8Array;
      recvKey?: Uint8Array;
    }> = [];
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler: new ImmediateScheduler(),
      wsFactory: () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const pending = manager.getLink(peer.nodeId);
    await waitUntil(() => resolvers.length >= 2, 2_000);
    for (const resolve of resolvers) {
      const [client, server] = fakeSocketPair();
      clients.push(client);
      void handshakeWsDirect({
        socket: server,
        role: 'acceptor',
        identity: peer,
        userStore: store,
      }).then((row) => {
        acceptors.push({ sendKey: row.sendKey, recvKey: row.recvKey });
      });
      resolve(client);
    }
    const link = await pending;
    expect(manager.getLive(peer.nodeId)).toBe(link);
    const keys = manager.sessionKeysOf(peer.nodeId);
    expect(keys).not.toBeNull();
    await waitUntil(() => acceptors.length >= 2, 2_000);
    const matched = acceptors.filter(
      (row) =>
        keys &&
        row.sendKey &&
        row.recvKey &&
        Buffer.from(keys.sendKey).equals(Buffer.from(row.recvKey)) &&
        Buffer.from(keys.recvKey).equals(Buffer.from(row.sendKey))
    );
    expect(matched).toHaveLength(1);
    expect(clients.filter((socket) => !socket.closed)).toHaveLength(1);
    expect(await Promise.race([link.closed.then(() => 'closed'), Promise.resolve('open')])).toBe(
      'open'
    );
  });

  test('ws-secure winner abort closes a losing factory socket that resolves late', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify(['ws://127.0.0.1:1/peer', 'ws://127.0.0.1:2/peer']),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    let resolveLate: ((ws: ReturnType<typeof fakeSocketPair>[0]) => void) | undefined;
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler: new ImmediateScheduler(),
      wsFactory: (url) => {
        if (url.includes(':1/')) {
          return new Promise((resolve) => {
            resolveLate = resolve;
          });
        }
        const [client, server] = fakeSocketPair();
        void handshakeWsDirect({
          socket: server,
          role: 'acceptor',
          identity: peer,
          userStore: store,
        });
        return client;
      },
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const link = await manager.getLink(peer.nodeId);
    expect(link).toBeTruthy();
    const [late] = fakeSocketPair();
    resolveLate?.(late);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(late.closed).toBe(true);
    expect(manager.getLive(peer.nodeId)).toBe(link);
  });

  test('stop() during a ws-secure race closes a factory socket that resolves after abort', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify(['ws://127.0.0.1:1/peer', 'ws://127.0.0.1:2/peer']),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const resolvers: Array<(ws: ReturnType<typeof fakeSocketPair>[0]) => void> = [];
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler: new ImmediateScheduler(),
      wsFactory: () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const pending = manager.getLink(peer.nodeId);
    await waitUntil(() => resolvers.length >= 1, 2_000);
    await manager.stop();
    await expect(pending).rejects.toBeInstanceOf(NodeUnreachableError);
    const lateSockets = resolvers.map((resolve) => {
      const [ws] = fakeSocketPair();
      resolve(ws);
      return ws;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(lateSockets.every((socket) => socket.closed)).toBe(true);
    expect(manager.listReach().get(peer.nodeId)).toBeNull();
  });

  test('stop after electing a ws-secure winner closes the untracked session', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify(['ws://127.0.0.1:1/peer', 'ws://127.0.0.1:2/peer']),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const inner = new ImmediateScheduler();
    const stopRef = { run: () => {} };
    let winnerClient: ReturnType<typeof fakeSocketPair>[0] | undefined;
    const scheduler: MeshScheduler = {
      now: () => inner.now(),
      interval: (fn, ms) => inner.interval(fn, ms),
      sleep(_ms, signal) {
        if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
        return new Promise((_resolve, reject) => {
          const onAbort = () => {
            void stopRef.run();
            reject(signal?.reason ?? new Error('aborted'));
          };
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
    };
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler,
      wsFactory: (url) => {
        const [client, server] = fakeSocketPair();
        if (url.includes(':1/')) winnerClient = client;
        void handshakeWsDirect({
          socket: server,
          role: 'acceptor',
          identity: peer,
          userStore: store,
        });
        return client;
      },
    });
    stopRef.run = () => {
      void manager.stop();
    };
    fixtures.push({ close, stop: () => manager.stop() });
    const pending = manager.getLink(peer.nodeId);
    await expect(pending).rejects.toBeInstanceOf(NodeUnreachableError);
    expect(winnerClient?.closed).toBe(true);
    expect(manager.getLive(peer.nodeId)).toBeNull();
    expect(manager.listReach().get(peer.nodeId)).toBeNull();
  });

  test('acceptor parks a second inbound and restores its keys when promoted', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const acceptor = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      hostname: '127.0.0.1',
      startServer: true,
      idleMs: 60_000,
    });
    fixtures.push({ close, stop: () => acceptor.stop() });
    await acceptor.start();
    const port = acceptor.listenPort;
    expect(port).toBeGreaterThan(0);
    const url = `ws://127.0.0.1:${port}/peer`;
    const first = await openInitiatorWs(url, peer, store);
    await waitUntil(() => acceptor.getLive(peer.nodeId) != null, 2_000);
    expect(keysMatchInitiator(acceptor.sessionKeysOf(peer.nodeId), first)).toBe(true);
    const second = await openInitiatorWs(url, peer, store);
    await waitUntil(() => second.session != null, 2_000);
    expect(keysMatchInitiator(acceptor.sessionKeysOf(peer.nodeId), first)).toBe(true);
    expect(keysMatchInitiator(acceptor.sessionKeysOf(peer.nodeId), second)).toBe(false);
    first.session.close('drop-live');
    await waitUntil(() => keysMatchInitiator(acceptor.sessionKeysOf(peer.nodeId), second), 2_000);
    expect(keysMatchInitiator(acceptor.sessionKeysOf(peer.nodeId), second)).toBe(true);
    expect(acceptor.getLive(peer.nodeId)).not.toBeNull();
  });

  test('linkDetailOf does not read peer records for endpoints', () => {
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
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const orig = store.getPeer.bind(store);
    let gets = 0;
    store.getPeer = ((nodeId: string) => {
      gets += 1;
      return orig(nodeId);
    }) as UserStore['getPeer'];
    const detail = manager.linkDetailOf(peer.nodeId);
    expect(gets).toBe(0);
    expect(detail.endpoints).toEqual([]);
    expect(detail.peerAddress).toBeNull();
    expect(detail.directFailure).toBeNull();
  });

  test('upgrade failure after an existing relay records only this attempt', async () => {
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
    const scheduler = new ImmediateScheduler();
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink,
      peerPort: 0,
      startServer: false,
      scheduler,
      connectTimeoutMs: 80,
      wsFactory: () => {
        throw new Error('refused');
      },
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const acceptP = incoming.then(async (stream) => {
      const result = await handshakeRelay({
        stream,
        role: 'acceptor',
        identity: peer,
        userStore: store,
      });
      echoQuiesceCaps(result.session);
      return result;
    });
    await Promise.all([manager.getLink(peer.nodeId), acceptP]);
    await waitUntil(() => manager.quiesceCapableOf(peer.nodeId));
    const first = manager.linkDetailOf(peer.nodeId);
    expect(first.directFailure?.dc).toBe('direct_capable=false');
    expect(first.directFailure?.ws).toMatch(/127\.0\.0\.1:1|all endpoints backing off/);
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify(['ws://127.0.0.1:2/peer']),
      inventoryJson: '{}',
      directCapable: true,
      lastSeenAt: Date.now(),
      listVersion: 2,
    });
    scheduler.nowMs += PEER_UPGRADE_COOLDOWN_MS;
    manager.notifyPeerEndpointsChanged(peer.nodeId);
    await waitUntil(
      () => manager.linkDetailOf(peer.nodeId).directFailure?.dc === 'datachannel unavailable',
      2_000
    );
    const second = manager.linkDetailOf(peer.nodeId);
    expect(second.directFailure?.dc).toBe('datachannel unavailable');
    expect(second.directFailure?.ws).toMatch(/127\.0\.0\.1:2/);
    expect(second.directFailure?.at).toBeGreaterThanOrEqual(first.directFailure?.at ?? 0);
    expect(manager.transportOf(peer.nodeId)).toBe('relay');
  });

  test('relay accept failure log uses a whitelisted category and strips C0/C1', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const uplink = dummyUplink(self, store);
    const captured: { fn: ((stream: LinkStream, from: string) => void) | null } = { fn: null };
    const orig = uplink.setOnRelayStream.bind(uplink);
    uplink.setOnRelayStream = (handler) => {
      captured.fn = handler;
      orig(handler);
    };
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink,
      peerPort: 0,
      startServer: false,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const acceptInbound = captured.fn;
    if (!acceptInbound) throw new Error('missing relay accept handler');

    const [local, remote] = createInMemoryLinkPair();
    const incoming = new Promise<LinkStream>((resolve) => local.onStream(resolve));
    const attacker = await remote.openStream(
      encodeJsonBytes({ to: self.nodeId, from: 'cc'.repeat(16) })
    );
    const stream = await incoming;
    const poison = '\u001b[31mevil\u0007\u009b]0;pwned';
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      acceptInbound(stream, 'cc'.repeat(16));
      await attacker.write(encodeJsonBytes({ t: poison }));
      attacker.reset(poison);
      await waitUntil(
        () => warnings.some((line) => line.includes('[mesh][relay] accept failed')),
        2_000
      );
    } finally {
      console.warn = origWarn;
    }
    const line = warnings.find((entry) => entry.includes('[mesh][relay] accept failed')) ?? '';
    expect(line).toMatch(/reason=(protocol|rst|timeout|unknown|bad_signature|revoked)\b/);
    expect(line).toContain('summary=');
    expect(
      [...line].every((ch) => {
        const c = ch.charCodeAt(0);
        return c > 31 && (c < 127 || c > 159);
      })
    ).toBe(true);
    expect(line.includes('\u001b')).toBe(false);
    expect(line.includes('\u0007')).toBe(false);
    const summary = line.split('summary=')[1] ?? '';
    expect(summary.length).toBeLessThanOrEqual(120);
  });
});

async function setupStatusPeer(fixtures: Array<{ close: () => void; stop?: () => Promise<void> }>) {
  const { db, close } = createMigratedAuthDb();
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
  const head = { seq: 1n, hash: new Uint8Array(32).fill(1) };
  let headCalls = 0;
  const scheduler = new ImmediateScheduler();
  const manager = new PeerManager({
    identity: self,
    userStore: store,
    uplink: dummyUplink(self, store),
    peerPort: 0,
    startServer: false,
    scheduler,
    keyLogApplier: {
      async head() {
        headCalls += 1;
        return { seq: head.seq, hash: head.hash };
      },
      async applyMany() {
        return { applied: 0 };
      },
    },
    statusProvider: (): UplinkStatus => ({
      version: '1',
      tmux: false,
      direct_capable: false,
      inventory: {},
      endpoints: [],
    }),
  });
  fixtures.push({ close, stop: () => manager.stop() });
  const [local, remote] = createInMemoryLinkPair();
  const statuses: Array<Record<string, unknown>> = [];
  remote.ctl.onMessage((bytes) => {
    try {
      const msg = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      if (msg.t === 'node.status') statuses.push(msg);
    } catch {
      /* ignore */
    }
  });
  echoQuiesceCaps(remote);
  expect(manager.adoptLink(peer.nodeId, local, 'ws-secure', self.nodeId)).toBe(local);
  return { manager, scheduler, statuses, head, headCalls: () => headCalls };
}
