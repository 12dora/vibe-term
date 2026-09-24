import { describe, expect, test } from 'bun:test';
import { createInMemoryLinkPair } from '@vibeterm/shared/link';
import type { MeshRouteMode } from '@vibeterm/shared/net';
import { encodeJsonBytes } from './ctl';
import { PeerEndpointBackoff } from './peer-endpoint-backoff';
import { getPeerLink } from './peer-get-link';
import { createPeerManagerState } from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';
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

function harness() {
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
    mode: fakeMode(),
    openRelay: async () => {
      const session = { closedReason: null } as unknown as LivePeer['session'];
      relays.push(session);
      const prev = state.live.get(PEER);
      state.live.set(PEER, liveOf(PEER, 'relay', session, 14));
      return session;
    },
    forceInstall: (session, peerId, transport) => {
      state.live.set(peerId, liveOf(peerId, transport, session, null));
      return session;
    },
    finishRetire: () => {},
    maybeUpgrade: () => {},
  });
  return { coord, state, relays };
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
      prev: relay,
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

  test('没有可复用的 relay 时改拨中继，而不是再交出这条 DC', async () => {
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

    const link = await getPeerLink(
      {
        state: h.state,
        routes: h.coord,
        maybeUpgrade() {},
        requireTrusted() {},
        dialForeground: async () => {
          throw new Error('dial foreground would race the dc');
        },
        awaitEstablishedOrDial: async (_id, pending) => pending,
      },
      PEER
    );
    expect(link).not.toBe(dc);
    expect(h.state.live.get(PEER)?.transport).toBe('relay');
    expect(h.relays).toHaveLength(1);
    h.coord.dispose();
  });
});
