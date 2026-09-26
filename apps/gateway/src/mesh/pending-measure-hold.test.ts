import { describe, expect, test } from 'bun:test';
import { LinkError, createInMemoryLinkPair } from '@vibeterm/shared/link';
import type { MeshRouteMode } from '@vibeterm/shared/net';
import { encodeJsonBytes } from './ctl';
import { noteAndContinuePlainHttp } from './forwarder-pre-dispatch-retry';
import { PeerEndpointBackoff } from './peer-endpoint-backoff';
import { getPeerLink } from './peer-get-link';
import { PEER_RETIRE_MAX_MS, createPeerManagerState } from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';
import { REMOTE_HOLD_MS, rememberLinkTransport } from './pending-measure-hold';
import { RouteDegradeCoordinator, type RouteModeHolder } from './route-degrade';
import { ImmediateScheduler } from './test-support';
import type { MeshIdentity, PeerTransportKind } from './types';
import type { PooledUplink } from './types';

const PEER = 'cd'.repeat(16);

function fakeMode(initial: MeshRouteMode = 'auto'): RouteModeHolder {
  return { get: () => initial, subscribe: () => () => {} };
}

function liveOf(
  peerId: string,
  transport: PeerTransportKind,
  session: LivePeer['session'],
  rttMs: number | null
): LivePeer {
  return {
    peerNodeId: peerId,
    transport,
    session,
    rttMs,
    generation: 1,
    retiring: transport !== 'dc',
    finishRetired: false,
  } as LivePeer;
}

function harness(mode: MeshRouteMode = 'auto') {
  const scheduler = new ImmediateScheduler();
  const identity = { nodeId: 'aa'.repeat(16), edSecretKey: new Uint8Array(64) } as MeshIdentity;
  const uplink = { rttMs: 14, resetBackoff() {} } as unknown as PooledUplink & {
    resetBackoff(): void;
  };
  const state = createPeerManagerState({
    identity,
    userStore: { getCert: () => ({ userId: 'user-1' }) } as never,
    uplink,
    scheduler,
    endpointBackoff: new PeerEndpointBackoff({ now: () => scheduler.now() }),
  });
  const relays: LivePeer['session'][] = [];
  const coord = new RouteDegradeCoordinator({
    state,
    mode: fakeMode(mode),
    openRelay: async () => {
      const [session] = createInMemoryLinkPair();
      relays.push(session);
      return session;
    },
    forceInstall: (session, peerId, transport) => {
      state.live.set(peerId, liveOf(peerId, transport, session, null));
      return session;
    },
    finishRetire: () => {},
    maybeUpgrade: () => {},
  });
  return { coord, state, relays, scheduler };
}

function quietHost(h: ReturnType<typeof harness>) {
  return {
    state: h.state,
    routes: h.coord,
    maybeUpgrade() {},
    requireTrusted() {},
    dialForeground: async () => {
      throw new Error('held dc must not dial');
    },
    awaitEstablishedOrDial: async (_id: string, pending: Promise<LivePeer['session']>) => pending,
  };
}

describe('pending-measure 接收侧不再把同一条 DC 当作用户链路', () => {
  test('对端 RST pending-measure 后 getPeerLink 回到 retiring relay', async () => {
    const h = harness();
    const [dc, remote] = createInMemoryLinkPair();
    const relay = liveOf(PEER, 'relay', { id: 'relay' } as unknown as LivePeer['session'], 15);
    h.state.retiring.set(PEER, new Set([relay]));
    h.state.live.set(PEER, liveOf(PEER, 'dc', dc, 10));
    h.coord.interceptTrack({
      session: dc,
      peerNodeId: PEER,
      transport: 'dc',
      initiatedBy: PEER,
      gen: 1,
      remoteAddress: null,
      dcAttemptId: 'dc:1',
      prev: h.state.live.get(PEER),
    });
    remote.onStream((stream) => stream.reset('pending-measure'));
    const opened = await dc.openStream(new Uint8Array([1]));
    await opened.closed;

    const link = await getPeerLink(
      {
        state: h.state,
        routes: h.coord,
        maybeUpgrade() {
          throw new Error('held dc must not upgrade');
        },
        requireTrusted() {},
        dialForeground: async () => {
          throw new Error('held dc must not dial');
        },
        awaitEstablishedOrDial: async (_id, pending) => pending,
      },
      PEER
    );
    expect(link).toBe(relay.session);
    expect(h.coord.allowsOutboundDirect(PEER)).toBe(false);

    remote.ctl.send(encodeJsonBytes({ t: 'route-promoted' }));
    await Bun.sleep(20);
    const promoted = await getPeerLink(
      {
        state: h.state,
        routes: h.coord,
        maybeUpgrade() {},
        requireTrusted() {},
        dialForeground: async () => {
          throw new Error('promoted dc is already live');
        },
        awaitEstablishedOrDial: async (_id, pending) => pending,
      },
      PEER
    );
    expect(promoted).toBe(dc);
    expect(h.coord.allowsOutboundDirect(PEER)).toBe(true);
    h.coord.dispose();
  });

  test('没有可复用的 relay 时旁路拨中继，不拆 DC 也不降级', async () => {
    const h = harness();
    const [dc, remote] = createInMemoryLinkPair();
    h.state.live.set(PEER, liveOf(PEER, 'dc', dc, 10));
    h.coord.interceptTrack({
      session: dc,
      peerNodeId: PEER,
      transport: 'dc',
      initiatedBy: PEER,
      gen: 1,
      remoteAddress: null,
      dcAttemptId: 'dc:2',
      prev: undefined,
    });
    remote.onStream((stream) => stream.reset('pending-measure'));
    const opened = await dc.openStream(new Uint8Array([1]));
    await opened.closed;

    const host = {
      state: h.state,
      routes: h.coord,
      maybeUpgrade() {},
      requireTrusted() {},
      dialForeground: async () => {
        throw new Error('dial foreground would race the dc');
      },
      awaitEstablishedOrDial: async (_id: string, pending: Promise<LivePeer['session']>) => pending,
    };
    const link = await getPeerLink(host, PEER);
    expect(link).not.toBe(dc);
    expect(h.state.live.get(PEER)?.session).toBe(dc);
    expect(h.coord.isDegraded(PEER)).toBe(false);
    const again = await getPeerLink(host, PEER);
    expect(again).toBe(link);
    expect(h.relays).toHaveLength(1);
    h.coord.dispose();
  });

  test('route-promoted 关掉旁路中继，DC 仍是 live', async () => {
    const h = harness();
    const [dc, remote] = createInMemoryLinkPair();
    h.state.live.set(PEER, liveOf(PEER, 'dc', dc, 10));
    h.coord.interceptTrack({
      session: dc,
      peerNodeId: PEER,
      transport: 'dc',
      initiatedBy: PEER,
      gen: 1,
      remoteAddress: null,
      dcAttemptId: 'dc:promoted',
      prev: undefined,
    });
    remote.onStream((stream) => stream.reset('pending-measure'));
    const opened = await dc.openStream(new Uint8Array([1]));
    await opened.closed;
    const link = await getPeerLink(quietHost(h), PEER);
    expect(link).not.toBe(dc);
    expect(h.state.sideRelays.get(PEER)).toBe(link);
    remote.ctl.send(encodeJsonBytes({ t: 'route-promoted' }));
    await Bun.sleep(20);
    expect(h.state.live.get(PEER)?.session).toBe(dc);
    expect(h.state.sideRelays.has(PEER)).toBe(false);
    expect((await link.closed).reason).toBe('route-promoted');
    h.coord.dispose();
  });

  test('route-promoted 排空旁路中继上的在途流，空闲才关', async () => {
    const h = harness();
    const [dc, remote] = createInMemoryLinkPair();
    h.state.live.set(PEER, liveOf(PEER, 'dc', dc, 10));
    h.coord.interceptTrack({
      session: dc,
      peerNodeId: PEER,
      transport: 'dc',
      initiatedBy: PEER,
      gen: 1,
      remoteAddress: null,
      dcAttemptId: 'dc:drain',
      prev: undefined,
    });
    remote.onStream((stream) => stream.reset('pending-measure'));
    const opened = await dc.openStream(new Uint8Array([1]));
    await opened.closed;
    const link = await getPeerLink(quietHost(h), PEER);
    expect(link).not.toBeNull();
    if (!link) throw new Error('missing side relay');
    const held = await link.openStream(new Uint8Array([7]));
    remote.ctl.send(encodeJsonBytes({ t: 'route-promoted' }));
    await Bun.sleep(20);
    expect(h.state.live.get(PEER)?.session).toBe(dc);
    expect(h.state.sideRelays.has(PEER)).toBe(false);
    let closed = false;
    void link.closed.then(() => {
      closed = true;
    });
    await Bun.sleep(20);
    expect(closed).toBe(false);
    held.reset('done');
    expect((await link.closed).reason).toBe('route-promoted');
    h.coord.dispose();
  });

  test('hold-expired 在排空上限后关掉还有流的旁路中继', async () => {
    const h = harness();
    const [dc, remote] = createInMemoryLinkPair();
    h.state.live.set(PEER, liveOf(PEER, 'dc', dc, 10));
    h.coord.interceptTrack({
      session: dc,
      peerNodeId: PEER,
      transport: 'dc',
      initiatedBy: PEER,
      gen: 1,
      remoteAddress: null,
      dcAttemptId: 'dc:drain-cap',
      prev: undefined,
    });
    remote.onStream((stream) => stream.reset('pending-measure'));
    const opened = await dc.openStream(new Uint8Array([1]));
    await opened.closed;
    const link = await getPeerLink(quietHost(h), PEER);
    if (!link) throw new Error('missing side relay');
    await link.openStream(new Uint8Array([7]));
    h.scheduler.advance(REMOTE_HOLD_MS);
    let closed = false;
    void link.closed.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    h.scheduler.advance(PEER_RETIRE_MAX_MS);
    expect((await link.closed).reason).toBe('hold-expired');
    expect(h.state.live.get(PEER)?.session).toBe(dc);
    h.coord.dispose();
  });

  test('测量窗口到期关掉旁路中继，不把 DC 拆掉', async () => {
    const h = harness();
    const [dc, remote] = createInMemoryLinkPair();
    h.state.live.set(PEER, liveOf(PEER, 'dc', dc, 10));
    h.coord.interceptTrack({
      session: dc,
      peerNodeId: PEER,
      transport: 'dc',
      initiatedBy: PEER,
      gen: 1,
      remoteAddress: null,
      dcAttemptId: 'dc:expiry',
      prev: undefined,
    });
    remote.onStream((stream) => stream.reset('pending-measure'));
    const opened = await dc.openStream(new Uint8Array([1]));
    await opened.closed;
    const link = await getPeerLink(quietHost(h), PEER);
    expect(h.state.sideRelays.get(PEER)).toBe(link);
    h.scheduler.advance(REMOTE_HOLD_MS);
    expect(h.state.live.get(PEER)?.session).toBe(dc);
    expect(h.state.sideRelays.has(PEER)).toBe(false);
    expect((await link.closed).reason).toBe('hold-expired');
    h.coord.dispose();
  });

  test('direct 模式测量期间不拨中继，把拒绝交回这条 DC', async () => {
    const h = harness('direct');
    const [dc, remote] = createInMemoryLinkPair();
    h.state.live.set(PEER, liveOf(PEER, 'dc', dc, 10));
    h.coord.interceptTrack({
      session: dc,
      peerNodeId: PEER,
      transport: 'dc',
      initiatedBy: PEER,
      gen: 1,
      remoteAddress: null,
      dcAttemptId: 'dc:direct',
      prev: undefined,
    });
    remote.onStream((stream) => stream.reset('pending-measure'));
    const opened = await dc.openStream(new Uint8Array([1]));
    await opened.closed;
    for (let i = 0; i < 5; i += 1) {
      const link = await getPeerLink(
        {
          state: h.state,
          routes: h.coord,
          maybeUpgrade() {},
          requireTrusted() {},
          dialForeground: async () => {
            throw new Error('direct hold must not dial');
          },
          awaitEstablishedOrDial: async (_id, pending) => pending,
        },
        PEER
      );
      expect(link).toBe(dc);
    }
    expect(h.relays).toHaveLength(0);
    expect(h.coord.isDegraded(PEER)).toBe(false);
    expect(h.state.live.get(PEER)?.session).toBe(dc);
    h.coord.dispose();
  });
});

describe('pending-measure quarantine', () => {
  test('只有直连上的 pending-measure 隔离节点；stale-link 和 parked 仍可重放', () => {
    const h = harness();
    const [dc] = createInMemoryLinkPair();
    const [relay] = createInMemoryLinkPair();
    rememberLinkTransport(dc, 'dc');
    rememberLinkTransport(relay, 'relay');
    h.state.live.set(PEER, liveOf(PEER, 'dc', dc, 10));
    const stale = new LinkError('rst', 'stale-link');
    const parked = new LinkError('rst', 'parked');
    const pending = new LinkError('rst', 'pending-measure');
    noteAndContinuePlainHttp({
      method: 'GET',
      attempt: 0,
      err: stale,
      canReplay: true,
      nodeId: PEER,
      link: relay,
    });
    noteAndContinuePlainHttp({
      method: 'GET',
      attempt: 0,
      err: parked,
      canReplay: true,
      nodeId: PEER,
      link: relay,
    });
    noteAndContinuePlainHttp({
      method: 'GET',
      attempt: 0,
      err: pending,
      canReplay: true,
      nodeId: PEER,
      link: relay,
    });
    expect(h.coord.allowsOutboundDirect(PEER)).toBe(true);
    expect(h.coord.isDegraded(PEER)).toBe(false);
    expect(
      noteAndContinuePlainHttp({
        method: 'POST',
        attempt: 0,
        err: stale,
        canReplay: true,
        nodeId: PEER,
        link: relay,
      })
    ).toBe(true);
    noteAndContinuePlainHttp({
      method: 'GET',
      attempt: 0,
      err: pending,
      canReplay: true,
      nodeId: PEER,
      link: dc,
    });
    expect(h.coord.allowsOutboundDirect(PEER)).toBe(false);
    expect(h.coord.isDegraded(PEER)).toBe(false);
    h.coord.dispose();
  });

  test('parked RST does not dial a throwaway side relay', async () => {
    const h = harness();
    const [dc, remote] = createInMemoryLinkPair();
    const live = liveOf(PEER, 'dc', dc, 10);
    h.state.live.set(PEER, live);
    h.coord.interceptTrack({
      session: dc,
      peerNodeId: PEER,
      transport: 'dc',
      initiatedBy: PEER,
      gen: 1,
      remoteAddress: null,
      dcAttemptId: 'dc:1',
      prev: live,
    });
    remote.onStream((stream) => stream.reset('parked'));
    const opened = await dc.openStream(new Uint8Array([1]));
    await opened.closed;
    for (let i = 0; i < 3; i += 1) {
      const link = await getPeerLink(quietHost(h) as never, PEER);
      expect(link).toBe(dc);
    }
    expect(h.relays).toHaveLength(0);
    h.coord.dispose();
  });
});
