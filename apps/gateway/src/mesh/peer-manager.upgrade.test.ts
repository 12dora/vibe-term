import { afterEach, describe, expect, test } from 'bun:test';
import {
  type ByteTransport,
  LinkMux,
  type LinkSession,
  createInMemoryLinkPair,
} from '@tmex/shared/link';
import type { NodeSessionStore } from '../auth/node-session-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import {
  PEER_RETIRE_MAX_MS,
  PEER_RETIRE_MIN_MS,
  PEER_RETIRE_QUIET_MS,
  PEER_UPGRADE_BACKOFF_CAP_MS,
  PEER_UPGRADE_COOLDOWN_MS,
  PeerManager,
} from './peer-manager';
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

const HTTP_OPEN = new TextEncoder().encode(
  JSON.stringify({ type: 'http', method: 'GET', path: '/api/auth/challenge' })
);

function dummySessionStore(): NodeSessionStore {
  return {
    verify: () => ({ ok: true, session: { userId: 'user-1' } }),
  } as unknown as NodeSessionStore;
}

class DelayedPipeEnd implements ByteTransport {
  peer: DelayedPipeEnd | null = null;
  hold = false;
  private readonly queue: Uint8Array[] = [];
  private readonly dataCbs: Array<(bytes: Uint8Array) => void> = [];
  private readonly closeCbs: Array<(reason?: string) => void> = [];
  closed = false;

  send(bytes: Uint8Array): void {
    if (this.closed) return;
    const peer = this.peer;
    if (!peer || peer.closed) return;
    const copy = bytes.slice();
    if (this.hold) {
      this.queue.push(copy);
      return;
    }
    for (const cb of peer.dataCbs) cb(copy);
  }

  flush(): void {
    const peer = this.peer;
    if (!peer || peer.closed) {
      this.queue.length = 0;
      return;
    }
    const pending = this.queue.splice(0);
    for (const bytes of pending) {
      for (const cb of peer.dataCbs) cb(bytes);
    }
  }

  onData(cb: (bytes: Uint8Array) => void): void {
    this.dataCbs.push(cb);
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeCbs.push(cb);
  }

  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    const peer = this.peer;
    this.peer = null;
    if (peer && !peer.closed) {
      peer.closed = true;
      peer.peer = null;
      for (const cb of peer.closeCbs) cb(reason);
    }
    for (const cb of this.closeCbs) cb(reason);
  }
}

function createDelayedLinkPair(): {
  left: LinkSession;
  right: LinkSession;
  holdLeftToRight: (hold: boolean) => void;
  holdRightToLeft: (hold: boolean) => void;
  flushLeftToRight: () => void;
  flushRightToLeft: () => void;
} {
  const a = new DelayedPipeEnd();
  const b = new DelayedPipeEnd();
  a.peer = b;
  b.peer = a;
  return {
    left: new LinkMux(a, { role: 'initiator' }),
    right: new LinkMux(b, { role: 'acceptor' }),
    holdLeftToRight: (hold) => {
      a.hold = hold;
    },
    holdRightToLeft: (hold) => {
      b.hold = hold;
    },
    flushLeftToRight: () => a.flush(),
    flushRightToLeft: () => b.flush(),
  };
}

function echoQuiesceCaps(session: LinkSession): void {
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

function collectStatusEndpoints(session: LinkSession): string[] {
  const seen: string[] = [];
  session.ctl.onMessage((bytes) => {
    try {
      const msg = JSON.parse(new TextDecoder().decode(bytes)) as {
        t?: string;
        endpoints?: unknown;
      };
      if (msg.t === 'node.status') seen.push(JSON.stringify(msg.endpoints ?? null));
    } catch {
      // ignore non-json ctl
    }
  });
  return seen;
}

function failingUplink(
  identity: { nodeId: string; edSecretKey: Uint8Array },
  userStore: UserStore
): UplinkClient {
  return dummyUplink(identity, userStore, async () => {
    throw new Error('no-relay');
  });
}

describe('PeerManager upgrade review fixes', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('single-sided upgrade accepts an in-flight OPEN on the retiring link', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const delayed = createDelayedLinkPair();
    let accepted = 0;
    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      sessionStore: dummySessionStore(),
      dispatchHttp: () => new Promise(() => {}),
    });
    const managerB = new PeerManager({
      identity: peer,
      userStore: store,
      uplink: dummyUplink(peer, store),
      peerPort: 0,
      startServer: false,
      sessionStore: dummySessionStore(),
      dispatchHttp: async () => {
        accepted += 1;
        return new Promise(() => {});
      },
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    fixtures.push({ close, stop: () => managerB.stop() });
    expect(managerA.adoptLink(peer.nodeId, delayed.left, 'relay', self.nodeId)).toBe(delayed.left);
    expect(managerB.adoptLink(self.nodeId, delayed.right, 'relay', self.nodeId)).toBe(
      delayed.right
    );
    await waitUntil(
      () => managerA.quiesceCapableOf(peer.nodeId) && managerB.quiesceCapableOf(self.nodeId),
      2_000
    );
    delayed.holdLeftToRight(true);

    const inflight = await delayed.left.openStream(HTTP_OPEN);
    const inflightClosed = inflight.closed.then((info) => info);

    const [wsA, wsB] = createInMemoryLinkPair();
    expect(managerB.adoptLink(self.nodeId, wsB, 'ws-secure', self.nodeId)).toBe(wsB);
    expect(managerA.adoptLink(peer.nodeId, wsA, 'ws-secure', self.nodeId)).toBe(wsA);
    expect(managerA.transportOf(peer.nodeId)).toBe('ws-secure');
    expect(managerB.transportOf(self.nodeId)).toBe('ws-secure');

    delayed.flushLeftToRight();
    await waitUntil(() => accepted === 1, 2_000);
    const raced = await Promise.race([
      inflightClosed,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]);
    expect(raced).toBeNull();
    expect(accepted).toBe(1);
  });

  test('simultaneous upgrades keep in-flight OPENs on both retiring links', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const delayed = createDelayedLinkPair();
    let acceptedA = 0;
    let acceptedB = 0;
    const [wsA, wsB] = createInMemoryLinkPair();
    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      sessionStore: dummySessionStore(),
      dispatchHttp: async () => {
        acceptedA += 1;
        return new Promise(() => {});
      },
      linkFactory: async () => wsA,
    });
    const managerB = new PeerManager({
      identity: peer,
      userStore: store,
      uplink: dummyUplink(peer, store),
      peerPort: 0,
      startServer: false,
      sessionStore: dummySessionStore(),
      dispatchHttp: async () => {
        acceptedB += 1;
        return new Promise(() => {});
      },
      linkFactory: async () => wsB,
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    fixtures.push({ close, stop: () => managerB.stop() });
    expect(managerA.adoptLink(peer.nodeId, delayed.left, 'relay', self.nodeId)).toBe(delayed.left);
    expect(managerB.adoptLink(self.nodeId, delayed.right, 'relay', self.nodeId)).toBe(
      delayed.right
    );
    await waitUntil(
      () => managerA.quiesceCapableOf(peer.nodeId) && managerB.quiesceCapableOf(self.nodeId),
      2_000
    );
    delayed.holdLeftToRight(true);
    delayed.holdRightToLeft(true);

    const openA = await delayed.left.openStream(HTTP_OPEN);
    const openB = await delayed.right.openStream(HTTP_OPEN);
    const closedA = openA.closed.then((info) => info);
    const closedB = openB.closed.then((info) => info);

    void managerA.getLink(peer.nodeId);
    void managerB.getLink(self.nodeId);
    await waitUntil(() => managerA.transportOf(peer.nodeId) === 'ws-secure', 2_000);
    await waitUntil(() => managerB.transportOf(self.nodeId) === 'ws-secure', 2_000);

    delayed.flushLeftToRight();
    delayed.flushRightToLeft();
    await waitUntil(() => acceptedA === 1 && acceptedB === 1, 2_000);
    const raced = await Promise.race([
      Promise.any([closedA, closedB]),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]);
    expect(raced).toBeNull();
    expect(acceptedA).toBe(1);
    expect(acceptedB).toBe(1);
  });

  test('alternating endpoints within cooldown coalesce into at most two upgrade dials', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const scheduler = new ImmediateScheduler();
    let dials = 0;
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
      uplink: failingUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler,
      connectTimeoutMs: 20,
      wsFactory: () => {
        throw new Error('no-ws');
      },
      linkFactory: async () => {
        dials += 1;
        throw new Error('dial-failed');
      },
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    const [relayA, relayB] = createInMemoryLinkPair();
    echoQuiesceCaps(relayB);
    expect(managerA.adoptLink(peer.nodeId, relayA, 'relay', self.nodeId)).toBe(relayA);
    for (let i = 0; i < 20; i++) {
      store.upsertPeer({
        nodeId: peer.nodeId,
        name: 'peer',
        endpointsJson: JSON.stringify([
          i % 2 === 0 ? 'ws://10.0.0.1:39001/peer' : 'ws://10.0.0.2:39001/peer',
        ]),
        inventoryJson: '{}',
        directCapable: false,
        lastSeenAt: Date.now(),
        listVersion: i + 1,
      });
      managerA.notifyPeerEndpointsChanged(peer.nodeId);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(dials).toBeLessThanOrEqual(2);
    expect(dials).toBe(1);
  });

  test('failed background upgrades exponential-backoff before the next dial', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const scheduler = new ImmediateScheduler();
    let dials = 0;
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
      uplink: failingUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler,
      connectTimeoutMs: 20,
      wsFactory: () => {
        throw new Error('no-ws');
      },
      linkFactory: async () => {
        dials += 1;
        throw new Error('dial-failed');
      },
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    const [relayA, relayB] = createInMemoryLinkPair();
    echoQuiesceCaps(relayB);
    expect(managerA.adoptLink(peer.nodeId, relayA, 'relay', self.nodeId)).toBe(relayA);
    const backoffCapMs = 5 * 60 * 1000;
    for (let i = 1; i <= 8; i++) {
      managerA.notifyPeerEndpointsChanged(peer.nodeId);
      await waitUntil(() => dials === i, 2_000);
      if (i < 8) scheduler.nowMs += backoffCapMs;
    }
    managerA.notifyPeerEndpointsChanged(peer.nodeId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dials).toBe(8);
    scheduler.nowMs += PEER_UPGRADE_COOLDOWN_MS;
    managerA.notifyPeerEndpointsChanged(peer.nodeId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dials).toBe(8);
    scheduler.nowMs += backoffCapMs;
    managerA.notifyPeerEndpointsChanged(peer.nodeId);
    await waitUntil(() => dials === 9, 2_000);
  });

  test('periodic upgrade scan respects the global dial semaphore', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peers = Array.from({ length: 10 }, () => seedNodeIdentity(store, 'user-1'));
    const scheduler = new ImmediateScheduler();
    let current = 0;
    let max = 0;
    const unblock: Array<() => void> = [];
    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: failingUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler,
      linkFactory: async () => {
        current += 1;
        max = Math.max(max, current);
        await new Promise<void>((resolve) => {
          unblock.push(() => {
            current -= 1;
            resolve();
          });
        });
        throw new Error('dial-failed');
      },
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    for (const peer of peers) {
      const [relayA, relayB] = createInMemoryLinkPair();
      echoQuiesceCaps(relayB);
      expect(managerA.adoptLink(peer.nodeId, relayA, 'relay', self.nodeId)).toBe(relayA);
      fixtures.push({ close: () => relayB.close('test') });
    }
    await managerA.start();
    scheduler.tickIntervals();
    await waitUntil(() => max >= 1, 2_000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(max).toBeLessThanOrEqual(4);
    expect(current).toBeLessThanOrEqual(4);
    for (const release of [...unblock]) release();
  });

  test('caps accepted peer endpoints by count and length', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const tried: string[] = [];
    const long = `ws://127.0.0.1:1/${'x'.repeat(300)}`;
    const endpoints = [
      long,
      ...Array.from({ length: 20 }, (_, i) => `ws://127.0.0.1:${10_000 + i}/peer`),
    ];
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: JSON.stringify(endpoints),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: failingUplink(self, store),
      peerPort: 0,
      startServer: false,
      connectTimeoutMs: 20,
      wsFactory: (url) => {
        tried.push(url);
        throw new Error('no-connect');
      },
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    const [relayA, relayB] = createInMemoryLinkPair();
    echoQuiesceCaps(relayB);
    expect(managerA.adoptLink(peer.nodeId, relayA, 'relay', self.nodeId)).toBe(relayA);
    managerA.notifyPeerEndpointsChanged(peer.nodeId);
    await waitUntil(() => tried.length > 0, 2_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tried).not.toContain(long);
    expect(tried.length).toBeLessThanOrEqual(16);
    expect(tried.length).toBe(16);
  });

  test('refresh advertises new status to a live peer whose link was not rebuilt', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const nodeA = seedNodeIdentity(store, 'user-1');
    const nodeB = seedNodeIdentity(store, 'user-1');
    const nodeC = seedNodeIdentity(store, 'user-1');
    let endpoints: unknown = ['ws://10.0.0.1:1/peer'];
    const scheduler = new ImmediateScheduler();
    const managerA = new PeerManager({
      identity: nodeA,
      userStore: store,
      uplink: dummyUplink(nodeA, store),
      peerPort: 0,
      startServer: false,
      scheduler,
      statusProvider: () => ({
        version: '1',
        tmux: false,
        direct_capable: false,
        inventory: {},
        endpoints,
        name: 'A',
      }),
    });
    const managerB = new PeerManager({
      identity: nodeB,
      userStore: store,
      uplink: dummyUplink(nodeB, store),
      peerPort: 0,
      startServer: false,
    });
    const managerC = new PeerManager({
      identity: nodeC,
      userStore: store,
      uplink: dummyUplink(nodeC, store),
      peerPort: 0,
      startServer: false,
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    fixtures.push({ close, stop: () => managerB.stop() });
    fixtures.push({ close, stop: () => managerC.stop() });

    const ab = createInMemoryLinkPair();
    const ac = createInMemoryLinkPair();
    const seenB = collectStatusEndpoints(ab[1]);
    const seenC = collectStatusEndpoints(ac[1]);
    expect(managerA.adoptLink(nodeB.nodeId, ab[0], 'ws-secure', nodeA.nodeId)).toBe(ab[0]);
    expect(managerB.adoptLink(nodeA.nodeId, ab[1], 'ws-secure', nodeA.nodeId)).toBe(ab[1]);
    expect(managerA.adoptLink(nodeC.nodeId, ac[0], 'ws-secure', nodeA.nodeId)).toBe(ac[0]);
    expect(managerC.adoptLink(nodeA.nodeId, ac[1], 'ws-secure', nodeA.nodeId)).toBe(ac[1]);
    await waitUntil(() => seenB.length === 1 && seenC.length === 1, 2_000);
    expect(seenB).toEqual(['["ws://10.0.0.1:1/peer"]']);
    expect(seenC).toEqual(['["ws://10.0.0.1:1/peer"]']);

    endpoints = ['ws://10.0.0.9:9/peer'];
    const ab2 = createInMemoryLinkPair();
    const seenB2 = collectStatusEndpoints(ab2[1]);
    expect(managerA.adoptLink(nodeB.nodeId, ab2[0], 'ws-secure', nodeA.nodeId)).toBe(ab2[0]);
    expect(managerB.adoptLink(nodeA.nodeId, ab2[1], 'ws-secure', nodeA.nodeId)).toBe(ab2[1]);
    await waitUntil(() => seenB2.length === 1, 2_000);
    expect(seenB2).toEqual(['["ws://10.0.0.9:9/peer"]']);
    expect(seenC).toEqual(['["ws://10.0.0.1:1/peer"]']);

    await managerA.start();
    scheduler.tickIntervals();
    await waitUntil(() => seenC.length === 2, 2_000);
    expect(seenC).toEqual(['["ws://10.0.0.1:1/peer"]', '["ws://10.0.0.9:9/peer"]']);
  });

  test('background upgrade is skipped when the peer does not ACK quiesce capability', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    let dials = 0;
    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: failingUplink(self, store),
      peerPort: 0,
      startServer: false,
      linkFactory: async () => {
        dials += 1;
        throw new Error('should-not-dial');
      },
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    const [relayA, relayB] = createInMemoryLinkPair();
    fixtures.push({ close: () => relayB.close('test') });
    expect(managerA.adoptLink(peer.nodeId, relayA, 'relay', self.nodeId)).toBe(relayA);
    managerA.notifyPeerEndpointsChanged(peer.nodeId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dials).toBe(0);
    expect(managerA.transportOf(peer.nodeId)).toBe('relay');
    expect(managerA.quiesceCapableOf(peer.nodeId)).toBe(false);
  });

  test('getLink does not replace an existing mixed-version link until quiesce is ACKed', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    let dials = 0;
    const [nextA, nextB] = createInMemoryLinkPair();
    fixtures.push({ close: () => nextB.close('test') });
    const managerIdle = new PeerManager({
      identity: self,
      userStore: store,
      uplink: failingUplink(self, store),
      peerPort: 0,
      startServer: false,
      linkFactory: async () => {
        dials += 1;
        return nextA;
      },
    });
    fixtures.push({ close, stop: () => managerIdle.stop() });
    const idlePair = createInMemoryLinkPair();
    expect(managerIdle.adoptLink(peer.nodeId, idlePair[0], 'relay', self.nodeId)).toBe(idlePair[0]);
    const kept = await managerIdle.getLink(peer.nodeId);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(kept).toBe(idlePair[0]);
    expect(dials).toBe(0);
    expect(managerIdle.transportOf(peer.nodeId)).toBe('relay');
    expect(managerIdle.quiesceCapableOf(peer.nodeId)).toBe(false);
  });

  test('getLink may still dial a new link when none exists without a quiesce ACK', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    let dials = 0;
    const [nextA, nextB] = createInMemoryLinkPair();
    fixtures.push({ close: () => nextB.close('test') });
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: failingUplink(self, store),
      peerPort: 0,
      startServer: false,
      linkFactory: async () => {
        dials += 1;
        return nextA;
      },
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const link = await manager.getLink(peer.nodeId);
    expect(dials).toBe(1);
    expect(link).toBe(nextA);
    expect(manager.transportOf(peer.nodeId)).toBe('ws-secure');
    expect(manager.quiesceCapableOf(peer.nodeId)).toBe(false);
  });

  test('retiring link with an active 60s stream is not hard-closed at the 30s cap', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const scheduler = new ImmediateScheduler();
    let accepted = 0;
    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler,
      sessionStore: dummySessionStore(),
      dispatchHttp: () => new Promise(() => {}),
    });
    const managerB = new PeerManager({
      identity: peer,
      userStore: store,
      uplink: dummyUplink(peer, store),
      peerPort: 0,
      startServer: false,
      scheduler,
      sessionStore: dummySessionStore(),
      dispatchHttp: async () => {
        accepted += 1;
        return new Promise(() => {});
      },
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    fixtures.push({ close, stop: () => managerB.stop() });
    const oldPair = createInMemoryLinkPair();
    expect(managerA.adoptLink(peer.nodeId, oldPair[0], 'relay', self.nodeId)).toBe(oldPair[0]);
    expect(managerB.adoptLink(self.nodeId, oldPair[1], 'relay', self.nodeId)).toBe(oldPair[1]);
    const inflight = await oldPair[0].openStream(HTTP_OPEN);
    const inflightClosed = inflight.closed.then((info) => info);
    await waitUntil(() => accepted === 1, 2_000);

    const [wsA, wsB] = createInMemoryLinkPair();
    expect(managerB.adoptLink(self.nodeId, wsB, 'ws-secure', self.nodeId)).toBe(wsB);
    expect(managerA.adoptLink(peer.nodeId, wsA, 'ws-secure', self.nodeId)).toBe(wsA);
    expect(managerA.transportOf(peer.nodeId)).toBe('ws-secure');

    scheduler.nowMs += PEER_RETIRE_MAX_MS + 30_000;
    scheduler.tickIntervals();
    const raced = await Promise.race([
      inflightClosed,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]);
    expect(raced).toBeNull();
    expect(accepted).toBe(1);
  });

  test('getLink upgrade of an existing link respects nextEligibleAt backoff', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const scheduler = new ImmediateScheduler();
    let dials = 0;
    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: failingUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler,
      connectTimeoutMs: 20,
      linkFactory: async () => {
        dials += 1;
        throw new Error('dial-failed');
      },
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    const [relayA, relayB] = createInMemoryLinkPair();
    echoQuiesceCaps(relayB);
    expect(managerA.adoptLink(peer.nodeId, relayA, 'relay', self.nodeId)).toBe(relayA);
    await waitUntil(() => managerA.quiesceCapableOf(peer.nodeId), 2_000);
    await managerA.getLink(peer.nodeId);
    await waitUntil(() => dials === 1, 2_000);
    await managerA.getLink(peer.nodeId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(dials).toBe(1);
    scheduler.nowMs += PEER_UPGRADE_BACKOFF_CAP_MS;
    await managerA.getLink(peer.nodeId);
    await waitUntil(() => dials === 2, 2_000);
  });

  test('legacy peer inbound upgrade with an OPEN in flight does not replace the live link', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const scheduler = new ImmediateScheduler();
    const delayed = createDelayedLinkPair();
    delayed.holdLeftToRight(true);
    let accepted = 0;
    delayed.right.onStream(() => {
      accepted += 1;
    });
    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: failingUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler,
      sessionStore: dummySessionStore(),
      dispatchHttp: () => new Promise(() => {}),
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    expect(managerA.adoptLink(peer.nodeId, delayed.left, 'relay', self.nodeId)).toBe(delayed.left);
    expect(managerA.quiesceCapableOf(peer.nodeId)).toBe(false);

    const inflight = await delayed.left.openStream(HTTP_OPEN);
    const inflightClosed = inflight.closed.then((info) => info);

    const [wsA, wsB] = createInMemoryLinkPair();
    fixtures.push({ close: () => wsB.close('test') });
    const kept = managerA.adoptLink(peer.nodeId, wsA, 'ws-secure', peer.nodeId);
    expect(kept).toBe(delayed.left);
    expect(managerA.transportOf(peer.nodeId)).toBe('relay');
    expect(managerA.quiesceCapableOf(peer.nodeId)).toBe(false);

    scheduler.nowMs += PEER_RETIRE_MIN_MS + PEER_RETIRE_QUIET_MS + PEER_RETIRE_MAX_MS;
    scheduler.tickIntervals();
    delayed.flushLeftToRight();
    await waitUntil(() => accepted === 1, 2_000);
    const raced = await Promise.race([
      inflightClosed,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]);
    expect(raced).toBeNull();
    expect(accepted).toBe(1);
    expect(managerA.transportOf(peer.nodeId)).toBe('relay');
  });
});
