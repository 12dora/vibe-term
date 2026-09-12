import { afterEach, describe, expect, test } from 'bun:test';
import type { LinkSession } from '@vibeterm/shared/link';
import type { NodeSessionStore } from '../auth/node-session-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { DC_REROLL_MAX_PER_HOUR } from './dc-reroll-policy';
import type { DcRerollCoordinator } from './peer-dc-reroll';
import { PeerManager } from './peer-manager';
import type { LivePeer } from './peer-reconnect-wake';
import { dummyUplink } from './peer-test-fixtures';
import { decodeSdpSignal } from './rtc/ice';
import { seedNodeIdentity, seedUser, waitUntil } from './test-support';
import type { PeerTransportKind } from './types';

const HTTP_OPEN = new TextEncoder().encode(
  JSON.stringify({ type: 'http', method: 'GET', path: '/api/auth/challenge' })
);

function dummySessionStore(): NodeSessionStore {
  return {
    verify: () => ({ ok: true, session: { userId: 'user-1' } }),
  } as unknown as NodeSessionStore;
}

type Fixture = { close: () => void; stop?: () => Promise<void> };

/** 两台真实 PeerManager + 假 node-datachannel：重掷会在同一对节点间再建一条独立的 PC。 */
async function setupRerollPair(fixtures: Fixture[]) {
  const { db, close } = createMigratedAuthDb();
  fixtures.push({ close });
  const store = new UserStore(db);
  seedUser(store);
  const small = seedNodeIdentity(store, 'user-1', { nodeId: new Uint8Array(16).fill(0x01) });
  const large = seedNodeIdentity(store, 'user-1', { nodeId: new Uint8Array(16).fill(0xff) });
  for (const [id, name] of [
    [small.nodeId, 'small'],
    [large.nodeId, 'large'],
  ] as const) {
    store.upsertPeer({
      nodeId: id,
      name,
      endpointsJson: '[]',
      inventoryJson: '{}',
      directCapable: true,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
  }
  const { createFakeNativeModule } = await import('./rtc/test-fakes');
  const { RtcPeerManager } = await import('./rtc');
  const fake = createFakeNativeModule();
  const iceConfigProvider = () => ({ stun: [] as string[], turn: null });
  const rtcOf = (identity: typeof small) =>
    new RtcPeerManager({
      loadNative: async () => fake.module,
      iceConfigProvider,
      identity,
      userStore: store,
      handshakeTimeoutMs: 2_000,
    });
  const rtcSmall = rtcOf(small);
  const rtcLarge = rtcOf(large);
  fixtures.push({ close: () => rtcSmall.close() });
  fixtures.push({ close: () => rtcLarge.close() });
  await Promise.all([rtcSmall.ready(), rtcLarge.ready()]);

  const holderSmall: { manager: PeerManager | null } = { manager: null };
  const holderLarge: { manager: PeerManager | null } = { manager: null };
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
  const uplinkSmall = dummyUplink(small, store);
  uplinkSmall.state = 'online';
  const holdOffers: Array<{
    t: string;
    rtcSession?: string;
    from?: string;
    to?: string;
    sdp?: string;
    candidate?: string;
  }> = [];
  const reorder = { offerAfterCandidate: false };
  uplinkSmall.sendCtl = (msg) => {
    const payload = msg as {
      t: string;
      rtcSession?: string;
      from?: string;
      to?: string;
      sdp?: string;
      candidate?: string;
    };
    if (
      reorder.offerAfterCandidate &&
      payload.t === 'rtc.signal' &&
      payload.sdp &&
      decodeSdpSignal(payload.sdp)?.type === 'offer'
    ) {
      holdOffers.push(payload);
      return;
    }
    forward(holderLarge, small.nodeId, payload);
    if (reorder.offerAfterCandidate && payload.t === 'rtc.signal' && payload.candidate) {
      const held = holdOffers.shift();
      if (held) forward(holderLarge, small.nodeId, held);
    }
  };
  const uplinkLarge = dummyUplink(large, store);
  uplinkLarge.state = 'online';
  uplinkLarge.sendCtl = (msg) => forward(holderSmall, large.nodeId, msg as never);

  const transportsLarge: Array<PeerTransportKind | null> = [];
  let httpStreams = 0;
  const managerSmall = new PeerManager({
    identity: small,
    userStore: store,
    uplink: uplinkSmall,
    peerPort: 0,
    startServer: false,
    rtc: rtcSmall,
  });
  const managerLarge = new PeerManager({
    identity: large,
    userStore: store,
    uplink: uplinkLarge,
    peerPort: 0,
    startServer: false,
    rtc: rtcLarge,
    sessionStore: dummySessionStore(),
    dispatchHttp: () => {
      httpStreams += 1;
      return new Promise(() => {});
    },
    onLinkInfo: (info) => transportsLarge.push(info.transport),
  });
  holderSmall.manager = managerSmall;
  holderLarge.manager = managerLarge;
  fixtures.push({ close, stop: () => managerSmall.stop() });
  fixtures.push({ close, stop: () => managerLarge.stop() });
  return {
    small,
    large,
    managerSmall,
    managerLarge,
    transportsLarge,
    httpStreamsOf: () => httpStreams,
    connections: fake.connections,
    reorder,
  };
}

function livePeerOf(manager: PeerManager, nodeId: string): LivePeer | undefined {
  return (manager as unknown as { state: { live: Map<string, LivePeer> } }).state.live.get(nodeId);
}

function rerollOf(manager: PeerManager): DcRerollCoordinator {
  return (manager as unknown as { reroll: DcRerollCoordinator }).reroll;
}

function meshInternals(manager: PeerManager) {
  return manager as unknown as {
    state: {
      live: Map<string, LivePeer>;
      parked: Map<string, { session: LinkSession }>;
      retiring: Map<string, Set<LivePeer>>;
    };
    dialer: { hasWsRerollInflight: (nodeId: string) => boolean };
  };
}

async function establishDc(
  pair: Awaited<ReturnType<typeof setupRerollPair>>
): Promise<LinkSession> {
  const link = await pair.managerLarge.getLink(pair.small.nodeId);
  await waitUntil(() => pair.managerSmall.transportOf(pair.large.nodeId) === 'dc', 5_000);
  await waitUntil(() => pair.managerLarge.transportOf(pair.small.nodeId) === 'dc', 5_000);
  // link.hello 双向走完后，两端都拿到 quiesce + reroll 能力。
  await waitUntil(() => pair.managerSmall.quiesceCapableOf(pair.large.nodeId), 5_000);
  await waitUntil(() => pair.managerLarge.quiesceCapableOf(pair.small.nodeId), 5_000);
  return link;
}

describe('DC 重掷（make-before-break）', () => {
  const fixtures: Fixture[] = [];
  afterEach(async () => {
    while (fixtures.length) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('重掷换上新 DC：旧 session 退役但不关，在途流继续跑，应答侧不掉线', async () => {
    const pair = await setupRerollPair(fixtures);
    await establishDc(pair);
    const oldSmall = pair.managerSmall.getLive(pair.large.nodeId);
    const oldLarge = pair.managerLarge.getLive(pair.small.nodeId);
    expect(oldSmall).toBeTruthy();

    // 旧链路上先挂一条一直不结束的 HTTP 流。
    const inflight = await (oldSmall as LinkSession).openStream(HTTP_OPEN);
    await waitUntil(() => pair.httpStreamsOf() === 1, 2_000);
    let inflightClosed = false;
    void inflight.closed.then(() => {
      inflightClosed = true;
    });

    const pcsBefore = pair.connections.length;
    pair.transportsLarge.length = 0;
    expect(pair.managerSmall.rerollDc(pair.large.nodeId)).toBe(true);
    await waitUntil(() => pair.managerSmall.getLive(pair.large.nodeId) !== oldSmall, 5_000);
    await waitUntil(() => pair.managerLarge.getLive(pair.small.nodeId) !== oldLarge, 5_000);

    // 新建了一对 PC（新端口对），两端仍是 dc。
    expect(pair.connections.length).toBeGreaterThan(pcsBefore);
    expect(pair.managerSmall.transportOf(pair.large.nodeId)).toBe('dc');
    expect(pair.managerLarge.transportOf(pair.small.nodeId)).toBe('dc');
    // 应答侧从头到尾没有报过离线：更高 epoch 的 offer 只淘汰在途 attempt，不动 live。
    expect(pair.transportsLarge).not.toContain(null);

    // 旧 session 退役中而不是被关掉，在途流照旧。
    expect(inflightClosed).toBe(false);
    const raced = await Promise.race([
      (oldSmall as LinkSession).closed.then(() => 'closed' as const),
      new Promise<'open'>((resolve) => setTimeout(() => resolve('open'), 50)),
    ]);
    expect(raced).toBe('open');
    expect(inflightClosed).toBe(false);
    expect(pair.httpStreamsOf()).toBe(1);
  }, 20_000);

  test('已有 DC 在途时重掷是空操作：只建一对新 PC', async () => {
    const pair = await setupRerollPair(fixtures);
    await establishDc(pair);
    const oldSmall = pair.managerSmall.getLive(pair.large.nodeId);
    const before = pair.connections.length;
    expect(pair.managerSmall.rerollDc(pair.large.nodeId)).toBe(true);
    expect(pair.managerSmall.rerollDc(pair.large.nodeId)).toBe(false);
    await waitUntil(() => pair.managerSmall.getLive(pair.large.nodeId) !== oldSmall, 5_000);
    await waitUntil(() => pair.managerLarge.transportOf(pair.small.nodeId) === 'dc', 5_000);
    expect(pair.connections.length - before).toBe(2);
  }, 20_000);

  test('每对端每小时最多 3 次', async () => {
    const pair = await setupRerollPair(fixtures);
    await establishDc(pair);
    for (let i = 0; i < DC_REROLL_MAX_PER_HOUR; i += 1) {
      const prev = pair.managerSmall.getLive(pair.large.nodeId);
      expect(pair.managerSmall.rerollDc(pair.large.nodeId)).toBe(true);
      await waitUntil(() => pair.managerSmall.getLive(pair.large.nodeId) !== prev, 5_000);
      await waitUntil(() => pair.managerSmall.quiesceCapableOf(pair.large.nodeId), 5_000);
    }
    expect(pair.managerSmall.rerollDc(pair.large.nodeId)).toBe(false);
  }, 30_000);

  test('应答侧（字典序较大的一端）不会自己发起重掷', async () => {
    const pair = await setupRerollPair(fixtures);
    await establishDc(pair);
    expect(pair.managerLarge.rerollDc(pair.small.nodeId)).toBe(false);
  }, 20_000);

  test('live DC 记下 ICE epoch；候选先于 offer 到达时重掷仍能建起新 DC', async () => {
    const pair = await setupRerollPair(fixtures);
    await establishDc(pair);
    const oldSmall = pair.managerSmall.getLive(pair.large.nodeId);
    const oldLarge = pair.managerLarge.getLive(pair.small.nodeId);
    const oldEpochSmall = livePeerOf(pair.managerSmall, pair.large.nodeId)?.rtcEpoch;
    const oldEpochLarge = livePeerOf(pair.managerLarge, pair.small.nodeId)?.rtcEpoch;
    expect(oldEpochSmall).toEqual(expect.any(Number));
    expect(oldEpochLarge).toBe(oldEpochSmall);

    pair.reorder.offerAfterCandidate = true;
    expect(pair.managerSmall.rerollDc(pair.large.nodeId)).toBe(true);
    await waitUntil(() => pair.managerSmall.getLive(pair.large.nodeId) !== oldSmall, 5_000);
    await waitUntil(() => pair.managerLarge.getLive(pair.small.nodeId) !== oldLarge, 5_000);
    expect(pair.managerSmall.transportOf(pair.large.nodeId)).toBe('dc');
    expect(pair.managerLarge.transportOf(pair.small.nodeId)).toBe('dc');
    const nextEpoch = livePeerOf(pair.managerLarge, pair.small.nodeId)?.rtcEpoch;
    expect(nextEpoch).toBeGreaterThan(oldEpochLarge as number);
  }, 20_000);

  test('NAT 应答侧仅有 TCP 样本时请求 offerer 重掷：新 DC、旧链退役、搬流', async () => {
    const pair = await setupRerollPair(fixtures);
    await establishDc(pair);
    const oldSmall = pair.managerSmall.getLive(pair.large.nodeId);
    const oldLarge = pair.managerLarge.getLive(pair.small.nodeId);
    const inflight = await (oldSmall as LinkSession).openStream(HTTP_OPEN);
    await waitUntil(() => pair.httpStreamsOf() === 1, 2_000);
    let inflightClosed = false;
    void inflight.closed.then(() => {
      inflightClosed = true;
    });
    const pcsBefore = pair.connections.length;
    pair.managerLarge.pathRttMemory.record(pair.small.nodeId, { kind: 'tcp-connect', rttMs: 90 });
    const live = livePeerOf(pair.managerLarge, pair.small.nodeId);
    expect(live).toBeTruthy();
    live!.rttMs = 190;
    live!.rttSamples = 3;
    live!.linkSinceAt = Date.now() - 30_000;
    rerollOf(pair.managerLarge).onRttSample(live as LivePeer, 190);
    await waitUntil(() => pair.managerSmall.getLive(pair.large.nodeId) !== oldSmall, 5_000);
    await waitUntil(() => pair.managerLarge.getLive(pair.small.nodeId) !== oldLarge, 5_000);
    expect(pair.connections.length).toBeGreaterThan(pcsBefore);
    expect(pair.managerSmall.transportOf(pair.large.nodeId)).toBe('dc');
    expect(pair.managerLarge.transportOf(pair.small.nodeId)).toBe('dc');
    const next = livePeerOf(pair.managerSmall, pair.large.nodeId);
    expect(next).toBeTruthy();
    next!.rttMs = 90;
    const offerer = rerollOf(pair.managerSmall);
    offerer.onRttSample(next as LivePeer, 90);
    offerer.onRttSample(next as LivePeer, 90);
    offerer.onRttSample(next as LivePeer, 90);
    await waitUntil(() => inflightClosed, 5_000);
    const raced = await Promise.race([
      (oldSmall as LinkSession).closed.then(() => 'closed' as const),
      new Promise<'open'>((resolve) => setTimeout(() => resolve('open'), 50)),
    ]);
    expect(raced).toBe('closed');
  }, 20_000);

  test('2.3.1 对端（无 reroll 能力）收不到 reroll-request', async () => {
    const pair = await setupRerollPair(fixtures);
    await establishDc(pair);
    const live = livePeerOf(pair.managerLarge, pair.small.nodeId);
    expect(live).toBeTruthy();
    live!.rerollCapable = false;
    const sent: string[] = [];
    const orig = live!.session.ctl.send.bind(live!.session.ctl);
    live!.session.ctl.send = (bytes: Uint8Array) => {
      sent.push(new TextDecoder().decode(bytes));
      return orig(bytes);
    };
    const oldSmall = pair.managerSmall.getLive(pair.large.nodeId);
    const pcs = pair.connections.length;
    pair.managerLarge.pathRttMemory.record(pair.small.nodeId, { kind: 'tcp-connect', rttMs: 90 });
    live!.rttMs = 190;
    live!.rttSamples = 3;
    live!.linkSinceAt = Date.now() - 30_000;
    rerollOf(pair.managerLarge).onRttSample(live as LivePeer, 190);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sent.some((row) => row.includes('link.reroll-request'))).toBe(false);
    expect(pair.connections.length).toBe(pcs);
    expect(pair.managerSmall.getLive(pair.large.nodeId)).toBe(oldSmall);
  }, 20_000);
});

async function setupWsRerollPair(fixtures: Fixture[]) {
  const { db, close } = createMigratedAuthDb();
  fixtures.push({ close });
  const store = new UserStore(db);
  seedUser(store);
  const small = seedNodeIdentity(store, 'user-1', { nodeId: new Uint8Array(16).fill(0x01) });
  const large = seedNodeIdentity(store, 'user-1', { nodeId: new Uint8Array(16).fill(0xff) });
  let httpStreams = 0;
  const managerLarge = new PeerManager({
    identity: large,
    userStore: store,
    uplink: dummyUplink(large, store),
    peerPort: 0,
    hostname: '127.0.0.1',
    startServer: true,
    idleMs: 60_000,
    sessionStore: dummySessionStore(),
    dispatchHttp: () => {
      httpStreams += 1;
      return new Promise(() => {});
    },
  });
  fixtures.push({ close, stop: () => managerLarge.stop() });
  await managerLarge.start();
  const port = managerLarge.listenPort;
  expect(port).toBeGreaterThan(0);
  store.upsertPeer({
    nodeId: large.nodeId,
    name: 'large',
    endpointsJson: JSON.stringify([`ws://127.0.0.1:${port}/peer`]),
    inventoryJson: '{}',
    directCapable: false,
    lastSeenAt: Date.now(),
    listVersion: 1,
  });
  store.upsertPeer({
    nodeId: small.nodeId,
    name: 'small',
    endpointsJson: '[]',
    inventoryJson: '{}',
    directCapable: false,
    lastSeenAt: Date.now(),
    listVersion: 1,
  });
  const managerSmall = new PeerManager({
    identity: small,
    userStore: store,
    uplink: dummyUplink(small, store),
    peerPort: 0,
    startServer: false,
    idleMs: 60_000,
  });
  fixtures.push({ close, stop: () => managerSmall.stop() });
  return { small, large, managerSmall, managerLarge, httpStreamsOf: () => httpStreams };
}

describe('ws-secure 重赛（make-before-break）', () => {
  const fixtures: Fixture[] = [];
  afterEach(async () => {
    while (fixtures.length) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('重赛换上新 ws-secure：旧 session 退役但不关，在途流继续跑', async () => {
    const pair = await setupWsRerollPair(fixtures);
    const link = await pair.managerSmall.getLink(pair.large.nodeId);
    await waitUntil(() => pair.managerSmall.transportOf(pair.large.nodeId) === 'ws-secure', 5_000);
    await waitUntil(() => pair.managerLarge.transportOf(pair.small.nodeId) === 'ws-secure', 5_000);
    await waitUntil(() => pair.managerSmall.quiesceCapableOf(pair.large.nodeId), 5_000);
    await waitUntil(() => pair.managerLarge.quiesceCapableOf(pair.small.nodeId), 5_000);
    const oldSmall = pair.managerSmall.getLive(pair.large.nodeId);
    const oldLarge = pair.managerLarge.getLive(pair.small.nodeId);
    expect(oldSmall).toBe(link);

    const inflight = await (oldSmall as LinkSession).openStream(HTTP_OPEN);
    await waitUntil(() => pair.httpStreamsOf() === 1, 2_000);
    let inflightClosed = false;
    void inflight.closed.then(() => {
      inflightClosed = true;
    });

    expect(pair.managerSmall.rerollDc(pair.large.nodeId)).toBe(true);
    await waitUntil(() => pair.managerSmall.getLive(pair.large.nodeId) !== oldSmall, 5_000);
    await waitUntil(() => pair.managerLarge.getLive(pair.small.nodeId) !== oldLarge, 5_000);
    expect(pair.managerSmall.transportOf(pair.large.nodeId)).toBe('ws-secure');
    expect(pair.managerLarge.transportOf(pair.small.nodeId)).toBe('ws-secure');
    expect(inflightClosed).toBe(false);
    const raced = await Promise.race([
      (oldSmall as LinkSession).closed.then(() => 'closed' as const),
      new Promise<'open'>((resolve) => setTimeout(() => resolve('open'), 50)),
    ]);
    expect(raced).toBe('open');
    expect(pair.httpStreamsOf()).toBe(1);
  }, 20_000);

  test('应答侧不会自己发起 ws-secure 重赛', async () => {
    const pair = await setupWsRerollPair(fixtures);
    await pair.managerSmall.getLink(pair.large.nodeId);
    await waitUntil(() => pair.managerLarge.quiesceCapableOf(pair.small.nodeId), 5_000);
    expect(pair.managerLarge.rerollDc(pair.small.nodeId)).toBe(false);
  }, 20_000);

  test('foreground ws dial 与重赛竞速：一条 live、无 parked', async () => {
    const pair = await setupWsRerollPair(fixtures);
    await pair.managerSmall.getLink(pair.large.nodeId);
    await waitUntil(() => pair.managerSmall.quiesceCapableOf(pair.large.nodeId), 5_000);
    await waitUntil(() => pair.managerLarge.quiesceCapableOf(pair.small.nodeId), 5_000);
    const oldSmall = pair.managerSmall.getLive(pair.large.nodeId);
    const oldLarge = pair.managerLarge.getLive(pair.small.nodeId);

    expect(pair.managerSmall.rerollDc(pair.large.nodeId)).toBe(true);
    expect(meshInternals(pair.managerSmall).dialer.hasWsRerollInflight(pair.large.nodeId)).toBe(
      true
    );
    const probe = pair.managerSmall.forceProbe(pair.large.nodeId);
    const probed = await probe;
    await waitUntil(() => {
      const live = pair.managerSmall.getLive(pair.large.nodeId);
      return live != null && (live !== oldSmall || probed === live);
    }, 5_000);
    await waitUntil(() => pair.managerLarge.transportOf(pair.small.nodeId) === 'ws-secure', 5_000);

    const liveSmall = pair.managerSmall.getLive(pair.large.nodeId);
    expect(liveSmall).toBeTruthy();
    expect(probed).toBe(liveSmall);
    expect(meshInternals(pair.managerSmall).state.parked.size).toBe(0);
    expect(meshInternals(pair.managerLarge).state.parked.size).toBe(0);
    expect(pair.managerSmall.transportOf(pair.large.nodeId)).toBe('ws-secure');
    const retired = meshInternals(pair.managerSmall).state.retiring.get(pair.large.nodeId);
    const oldRetired = Boolean(retired && [...retired].some((row) => row.session === oldSmall));
    const rerollDropped = liveSmall === oldSmall;
    expect(oldRetired || rerollDropped || liveSmall !== oldSmall).toBe(true);
    expect(oldLarge).toBeTruthy();
  }, 20_000);

  test('已有 foreground ws 在途时 rerollDc 放弃，无 parked', async () => {
    const pair = await setupWsRerollPair(fixtures);
    await pair.managerSmall.getLink(pair.large.nodeId);
    await waitUntil(() => pair.managerSmall.quiesceCapableOf(pair.large.nodeId), 5_000);
    const oldSmall = pair.managerSmall.getLive(pair.large.nodeId);
    const probe = pair.managerSmall.forceProbe(pair.large.nodeId);
    expect(meshInternals(pair.managerSmall).dialer.hasWsRerollInflight(pair.large.nodeId)).toBe(
      true
    );
    expect(pair.managerSmall.rerollDc(pair.large.nodeId)).toBe(false);
    const probed = await probe;
    expect(probed).toBeTruthy();
    expect(meshInternals(pair.managerSmall).state.parked.size).toBe(0);
    expect(meshInternals(pair.managerLarge).state.parked.size).toBe(0);
    expect(pair.managerSmall.getLive(pair.large.nodeId)).toBeTruthy();
    expect(oldSmall).toBeTruthy();
  }, 20_000);
});
