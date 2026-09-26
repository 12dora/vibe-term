import { afterEach, describe, expect, test } from 'bun:test';
import { type LinkSession, createInMemoryLinkPair } from '@vibeterm/shared/link';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { encodeJsonBytes } from './ctl';
import { PeerManager } from './peer-manager';
import { PEER_PING_INTERVAL_MS } from './peer-manager-state';
import { dummyUplink } from './peer-test-fixtures';
import { ImmediateScheduler, seedNodeIdentity, seedUser } from './test-support';

const HTTP_OPEN = encodeJsonBytes({
  type: 'http',
  method: 'GET',
  path: '/api/auth/challenge',
});

type LiveRow = {
  session: LinkSession;
  transport: string;
  rttMs: number | null;
  quiesceCapable: boolean;
};

type Host = {
  state: { live: Map<string, LiveRow> };
  routes: {
    armBackoff(peerId: string, degraded: boolean): void;
    isDegraded(peerId: string): boolean;
    hasCandidate(peerId: string): boolean;
    noteCandidateSample(peerId: string, sampleMs: number): void;
    offerCandidate(input: {
      session: LinkSession;
      peerNodeId: string;
      transport: 'dc' | 'ws-secure';
      initiatedBy: string;
      gen: number;
    }): 'held' | 'installed' | 'rejected';
    dropCandidates(peerId: string, reason?: string): void;
  };
  registry: { parkSide(peerId: string, session: LinkSession): void };
};

function answerPings(remote: LinkSession): void {
  remote.ctl.onMessage((bytes) => {
    let msg: { t?: string; sentAt?: number };
    try {
      msg = JSON.parse(new TextDecoder().decode(bytes)) as { t?: string; sentAt?: number };
    } catch {
      return;
    }
    if (msg.t !== 'ping') return;
    remote.ctl.send(encodeJsonBytes({ t: 'pong', sentAt: msg.sentAt }));
  });
}

describe('link lifecycle: one owner per session', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  function setup() {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler: new ImmediateScheduler(),
    });
    fixtures.push({ close, stop: () => manager.stop() });
    return { manager, self, peer, host: manager as unknown as Host };
  }

  test('degraded DC is measured once, then one live owner dispatches', async () => {
    const { manager, self, peer, host } = setup();
    const [relayL, relayR] = createInMemoryLinkPair();
    answerPings(relayR);
    expect(manager.adoptLink(peer.nodeId, relayL, 'relay', self.nodeId)).toBe(relayL);
    const relayLive = host.state.live.get(peer.nodeId);
    expect(relayLive).toBeDefined();
    if (!relayLive) return;
    relayLive.rttMs = 186;
    host.routes.armBackoff(peer.nodeId, true);

    const [dcL, dcR] = createInMemoryLinkPair();
    answerPings(dcR);
    expect(manager.adoptLink(peer.nodeId, dcL, 'dc', self.nodeId)).toBe(relayL);
    expect(host.routes.hasCandidate(peer.nodeId)).toBe(true);
    const held = await dcR.openStream(HTTP_OPEN);
    expect((await held.closed).message).toBe('pending-measure');

    host.routes.noteCandidateSample(peer.nodeId, 132);
    host.routes.noteCandidateSample(peer.nodeId, 132);
    host.routes.noteCandidateSample(peer.nodeId, 132);
    const promoted = host.state.live.get(peer.nodeId);
    expect(promoted?.session).toBe(dcL);
    expect(promoted?.transport).toBe('dc');
    expect(promoted).not.toBe(relayLive);
    const listeners = (dcL as unknown as { streamListeners: unknown[] }).streamListeners.length;
    expect(listeners).toBe(1);
    const stream = await dcR.openStream(HTTP_OPEN);
    const info = await stream.closed;
    expect(info.reason).toBe('rst');
    expect(info.message).toBe('http-not-configured');
  });

  test('DC between the two thresholds is rejected and the relay stays live', () => {
    const { manager, self, peer, host } = setup();
    const [relayL, relayR] = createInMemoryLinkPair();
    answerPings(relayR);
    manager.adoptLink(peer.nodeId, relayL, 'relay', self.nodeId);
    const live = host.state.live.get(peer.nodeId);
    expect(live).toBeDefined();
    if (!live) return;
    live.rttMs = 186;
    host.routes.armBackoff(peer.nodeId, true);
    const [dcL, dcR] = createInMemoryLinkPair();
    answerPings(dcR);
    void dcR;
    manager.adoptLink(peer.nodeId, dcL, 'dc', self.nodeId);
    host.routes.noteCandidateSample(peer.nodeId, 170);
    host.routes.noteCandidateSample(peer.nodeId, 170);
    host.routes.noteCandidateSample(peer.nodeId, 170);
    expect(host.state.live.get(peer.nodeId)?.session).toBe(relayL);
    expect(host.state.live.get(peer.nodeId)?.transport).toBe('relay');
  });

  test('hello queued before adopt still marks quiesceCapable', async () => {
    const { manager, self, peer, host } = setup();
    const [local, remote] = createInMemoryLinkPair();
    remote.ctl.send(encodeJsonBytes({ t: 'link.hello', caps: ['quiesce'] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    manager.adoptLink(peer.nodeId, local, 'relay', self.nodeId);
    expect(host.state.live.get(peer.nodeId)?.quiesceCapable).toBe(true);
  });

  test('dropCandidates closes a held DC without installing it', () => {
    const { manager, self, peer, host } = setup();
    const [relayL, relayR] = createInMemoryLinkPair();
    answerPings(relayR);
    manager.adoptLink(peer.nodeId, relayL, 'relay', self.nodeId);
    const live = host.state.live.get(peer.nodeId);
    expect(live).toBeDefined();
    if (!live) return;
    live.rttMs = 186;
    host.routes.armBackoff(peer.nodeId, true);
    const [dcL] = createInMemoryLinkPair();
    manager.adoptLink(peer.nodeId, dcL, 'dc', self.nodeId);
    expect(host.routes.hasCandidate(peer.nodeId)).toBe(true);
    host.routes.dropCandidates(peer.nodeId, 'paused');
    expect(host.routes.hasCandidate(peer.nodeId)).toBe(false);
    expect(host.state.live.get(peer.nodeId)?.session).toBe(relayL);
  });

  test('reroll against a direct live with no RTT is rejected', () => {
    const { manager, self, peer, host } = setup();
    const [dcL] = createInMemoryLinkPair();
    manager.adoptLink(peer.nodeId, dcL, 'dc', self.nodeId);
    const live = host.state.live.get(peer.nodeId);
    expect(live).toBeDefined();
    if (!live) return;
    live.rttMs = null;
    const [next] = createInMemoryLinkPair();
    const result = host.routes.offerCandidate({
      session: next,
      peerNodeId: peer.nodeId,
      transport: 'dc',
      initiatedBy: self.nodeId,
      gen: 1,
    });
    expect(result).toBe('rejected');
    expect(host.state.live.get(peer.nodeId)?.session).toBe(dcL);
  });

  test('parkSide of the live relay is a no-op', () => {
    const { manager, self, peer, host } = setup();
    const [relayL] = createInMemoryLinkPair();
    manager.adoptLink(peer.nodeId, relayL, 'relay', self.nodeId);
    host.registry.parkSide(peer.nodeId, relayL);
    expect(host.state.live.get(peer.nodeId)?.session).toBe(relayL);
  });

  test('promote relay to DC keeps the in-flight relay stream', async () => {
    const { manager, self, peer, host } = setup();
    const [relayL, relayR] = createInMemoryLinkPair();
    answerPings(relayR);
    relayR.onStream(() => {});
    manager.adoptLink(peer.nodeId, relayL, 'relay', self.nodeId);
    const relayLive = host.state.live.get(peer.nodeId);
    expect(relayLive).toBeDefined();
    if (!relayLive) return;
    (relayLive as { rttMs: number }).rttMs = 186;
    const inflight = await relayL.openStream(HTTP_OPEN);
    let closedInfo: { reason?: string } | null = null;
    void relayL.closed.then((info) => {
      closedInfo = info;
    });
    let streamInfo: { reason?: string } | null = null;
    void inflight.closed.then((info) => {
      streamInfo = info;
    });
    const [dcL, dcR] = createInMemoryLinkPair();
    answerPings(dcR);
    manager.adoptLink(peer.nodeId, dcL, 'dc', self.nodeId);
    expect(host.routes.hasCandidate(peer.nodeId)).toBe(true);
    host.routes.noteCandidateSample(peer.nodeId, 40);
    await Promise.resolve();
    expect(host.state.live.get(peer.nodeId)?.session).toBe(dcL);
    expect(closedInfo).toBeNull();
    expect(streamInfo).toBeNull();
  });

  test('a non-degraded promote does not force the remote off its relay while it is still measuring', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const a = seedNodeIdentity(store, 'user-1');
    const b = seedNodeIdentity(store, 'user-1');
    const scheduler = new ImmediateScheduler();
    scheduler.sleep = () => new Promise(() => {});
    const mk = (id: typeof a) =>
      new PeerManager({
        identity: id,
        userStore: store,
        uplink: dummyUplink(id, store),
        peerPort: 0,
        startServer: false,
        scheduler,
      });
    const A = mk(a);
    const B = mk(b);
    fixtures.push({ close, stop: () => A.stop() }, { close, stop: () => B.stop() });
    const [rA, rB] = createInMemoryLinkPair();
    A.adoptLink(b.nodeId, rA, 'relay', a.nodeId);
    B.adoptLink(a.nodeId, rB, 'relay', a.nodeId);
    const aRoutes = A as unknown as Host;
    const bRoutes = B as unknown as Host;
    (aRoutes.state.live.get(b.nodeId) as { rttMs: number }).rttMs = 50;
    (bRoutes.state.live.get(a.nodeId) as { rttMs: number }).rttMs = 50;
    bRoutes.routes.armBackoff(a.nodeId, true);
    const [dA, dB] = createInMemoryLinkPair();
    B.adoptLink(a.nodeId, dB, 'dc', a.nodeId);
    expect(bRoutes.routes.hasCandidate(a.nodeId)).toBe(true);
    A.adoptLink(b.nodeId, dA, 'dc', a.nodeId);
    await Promise.resolve();
    expect(bRoutes.state.live.get(a.nodeId)?.transport).toBe('relay');
    expect(bRoutes.routes.hasCandidate(a.nodeId)).toBe(true);
  });

  test('divergent DC reroll leaves the rejecting side on the old DC', () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const a = seedNodeIdentity(store, 'user-1');
    const b = seedNodeIdentity(store, 'user-1');
    const mk = (id: typeof a) =>
      new PeerManager({
        identity: id,
        userStore: store,
        uplink: dummyUplink(id, store),
        peerPort: 0,
        startServer: false,
        scheduler: new ImmediateScheduler(),
      });
    const A = mk(a);
    const B = mk(b);
    fixtures.push({ close, stop: () => A.stop() }, { close, stop: () => B.stop() });
    const [oldA, oldB] = createInMemoryLinkPair();
    A.adoptLink(b.nodeId, oldA, 'dc', a.nodeId);
    B.adoptLink(a.nodeId, oldB, 'dc', a.nodeId);
    const aHost = A as unknown as Host;
    const bHost = B as unknown as Host;
    (aHost.state.live.get(b.nodeId) as { rttMs: number }).rttMs = 40;
    (bHost.state.live.get(a.nodeId) as { rttMs: number }).rttMs = 40;
    const [newA] = createInMemoryLinkPair();
    const [newB] = createInMemoryLinkPair();
    const offer = (session: typeof newA, peer: string) => ({
      session,
      peerNodeId: peer,
      transport: 'dc' as const,
      initiatedBy: a.nodeId,
      gen: 0,
    });
    expect(aHost.routes.offerCandidate(offer(newA, b.nodeId))).toBe('held');
    expect(bHost.routes.offerCandidate(offer(newB, a.nodeId))).toBe('held');
    aHost.routes.noteCandidateSample(b.nodeId, 30);
    bHost.routes.noteCandidateSample(a.nodeId, 33);
    const la = aHost.state.live.get(b.nodeId);
    const lb = bHost.state.live.get(a.nodeId);
    expect(la?.session).toBe(newA);
    expect(lb?.session).toBe(oldB);
  });

  test('a retiring DC closes on missed pong instead of lingering', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
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
    const host = manager as unknown as Host;
    const [oldL, oldR] = createInMemoryLinkPair();
    oldR.onStream(() => {});
    manager.adoptLink(peer.nodeId, oldL, 'dc', self.nodeId);
    (host.state.live.get(peer.nodeId) as { rttMs: number }).rttMs = 40;
    await oldL.openStream(HTTP_OPEN);
    const [nextL, nextR] = createInMemoryLinkPair();
    answerPings(nextR);
    expect(
      host.routes.offerCandidate({
        session: nextL,
        peerNodeId: peer.nodeId,
        transport: 'dc',
        initiatedBy: self.nodeId,
        gen: 0,
      })
    ).toBe('held');
    host.routes.noteCandidateSample(peer.nodeId, 20);
    expect(host.state.live.get(peer.nodeId)?.session).toBe(nextL);
    const pipe = oldL as unknown as { transport: { peer: { peer: unknown } | null } };
    const other = pipe.transport.peer;
    pipe.transport.peer = null;
    if (other) other.peer = null;
    for (let i = 0; i < 8; i += 1) {
      scheduler.advance(PEER_PING_INTERVAL_MS);
      for (let step = 0; step < 4; step += 1) await Promise.resolve();
    }
    expect((await oldL.closed).reason).toBe('missed-pong');
  });

  test('retiring DC pong only clears missed pongs', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const infos: Array<{ transport: string | null; rttMs: number | null }> = [];
    const scheduler = new ImmediateScheduler();
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler,
      onLinkInfo: (info) => {
        infos.push({ transport: info.transport, rttMs: info.rttMs });
      },
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const internal = manager as unknown as {
      state: {
        live: Map<
          string,
          { transport: string; retiring: boolean; rttMs: number | null; missedPongs: number }
        >;
        generation: number;
      };
      registry: {
        forceInstall: (
          session: LinkSession,
          peerNodeId: string,
          transport: 'relay',
          initiatedBy: string,
          gen: number
        ) => LinkSession | null;
      };
    };
    const [dcL, dcR] = createInMemoryLinkPair();
    dcR.ctl.onMessage((bytes) => {
      const msg = JSON.parse(new TextDecoder().decode(bytes)) as { t?: string; sentAt?: number };
      if (msg.t !== 'ping') return;
      setTimeout(() => dcR.ctl.send(encodeJsonBytes({ t: 'pong', sentAt: msg.sentAt })), 40);
    });
    dcR.onStream(() => {});
    manager.adoptLink(peer.nodeId, dcL, 'dc', self.nodeId);
    const dcLive = internal.state.live.get(peer.nodeId);
    await dcL.openStream(HTTP_OPEN);
    const [relayL] = createInMemoryLinkPair();
    internal.registry.forceInstall(
      relayL,
      peer.nodeId,
      'relay',
      self.nodeId,
      internal.state.generation
    );
    expect(internal.state.live.get(peer.nodeId)?.transport).toBe('relay');
    expect(dcLive?.retiring).toBe(true);
    infos.length = 0;
    scheduler.advance(15_000);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(infos.every((info) => info.transport === 'relay')).toBe(true);
    expect(dcLive?.rttMs).toBeNull();
    expect(dcLive?.missedPongs).toBe(0);
    expect(manager.pathRttMemory.samplesOf(peer.nodeId)).toEqual([]);
    expect(internal.state.live.get(peer.nodeId)?.transport).toBe('relay');
  });

  test('inbound OPEN of an unknown type is reset', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler: new ImmediateScheduler(),
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [local, remote] = createInMemoryLinkPair();
    manager.adoptLink(peer.nodeId, local, 'relay', self.nodeId);
    const stream = await remote.openStream(encodeJsonBytes({ type: 'future-kind' }));
    const info = await stream.closed;
    expect(info.reason).toBe('rst');
    expect(info.message).toBe('unknown-stream-type');
    const live = (
      manager as unknown as {
        state: { live: Map<string, { streams: number }> };
      }
    ).state.live.get(peer.nodeId);
    expect(live?.streams).toBe(0);
  });
});
