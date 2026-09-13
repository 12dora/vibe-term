import { describe, expect, test } from 'bun:test';
import { type LinkSession, createInMemoryLinkPair } from '@vibeterm/shared/link';
import type { MeshRouteMode } from '@vibeterm/shared/net';
import { PeerEndpointBackoff } from './peer-endpoint-backoff';
import { createPeerManagerState } from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';
import { RouteDegradeCoordinator, type RouteModeHolder } from './route-degrade';
import { ImmediateScheduler } from './test-support';
import type { MeshIdentity, PeerTransportKind } from './types';
import type { UplinkClient } from './uplink-client';

const PEER = 'bb'.repeat(16);

function fakeMode(
  initial: MeshRouteMode = 'auto'
): RouteModeHolder & { set(mode: MeshRouteMode): void } {
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

function stubSession(): LinkSession & { closedReason: string | null } {
  const row = {
    closedReason: null as string | null,
    ctl: {
      send: () => undefined,
      onMessage: () => undefined,
    },
    close(reason?: string) {
      row.closedReason = reason ?? 'closed';
    },
    onStream: () => undefined,
    closed: new Promise<{ reason?: string }>(() => {}),
  };
  return row as unknown as LinkSession & { closedReason: string | null };
}

function liveOf(
  peerId: string,
  transport: PeerTransportKind,
  session: LinkSession,
  rttMs: number | null
): LivePeer {
  return {
    peerNodeId: peerId,
    transport,
    session,
    rttMs,
    generation: 1,
  } as LivePeer;
}

function makeHarness(
  opts: {
    mode?: MeshRouteMode;
    uplinkMs?: number;
    openRelay?: () => Promise<LinkSession>;
  } = {}
) {
  const scheduler = new ImmediateScheduler();
  const mode = fakeMode(opts.mode ?? 'auto');
  const identity = { nodeId: 'aa'.repeat(16), edSecretKey: new Uint8Array(64) } as MeshIdentity;
  const uplink = { rttMs: opts.uplinkMs ?? 14 } as unknown as UplinkClient;
  const state = createPeerManagerState({
    identity,
    userStore: { getCert: () => ({ userId: 'user-1' }) } as never,
    uplink,
    scheduler,
    endpointBackoff: new PeerEndpointBackoff({ now: () => scheduler.now() }),
  });
  const installed: Array<{ transport: PeerTransportKind; session: LinkSession }> = [];
  const retired: LinkSession[] = [];
  const relays: LinkSession[] = [];
  const upgrades: string[] = [];
  const coord = new RouteDegradeCoordinator({
    state,
    mode,
    openRelay:
      opts.openRelay ??
      (async () => {
        const session = stubSession();
        relays.push(session);
        const prev = state.live.get(PEER);
        const live = liveOf(PEER, 'relay', session, uplink.rttMs ?? 14);
        state.live.set(PEER, live);
        if (prev) retired.push(prev.session);
        installed.push({ transport: 'relay', session });
        return session;
      }),
    forceInstall: (session, peerId, transport) => {
      const prev = state.live.get(peerId);
      const live = liveOf(peerId, transport, session, null);
      state.live.set(peerId, live);
      installed.push({ transport, session });
      if (prev && prev.session !== session) retired.push(prev.session);
      return session;
    },
    finishRetire: (live) => {
      retired.push(live.session);
    },
    maybeUpgrade: (nodeId) => {
      upgrades.push(nodeId);
    },
  });
  return { coord, state, mode, scheduler, installed, retired, relays, upgrades };
}

describe('RouteDegradeCoordinator hysteresis', () => {
  test('2 次慢样本不降级，第 3 次且跨度 ≥ 15 s 才切 relay', async () => {
    const h = makeHarness();
    const dc = stubSession();
    const live = liveOf(PEER, 'dc', dc, 225);
    h.state.live.set(PEER, live);

    h.coord.onRttSample(live, 225);
    h.scheduler.nowMs += 5_000;
    h.coord.onRttSample(live, 225);
    expect(h.relays).toHaveLength(0);
    expect(h.coord.isDegraded(PEER)).toBe(false);

    h.scheduler.nowMs += 10_000;
    h.coord.onRttSample(live, 225);
    await Promise.resolve();
    expect(h.relays).toHaveLength(1);
    expect(h.coord.isDegraded(PEER)).toBe(true);
    expect(h.state.live.get(PEER)?.transport).toBe('relay');
    h.coord.dispose();
  });

  test('中间一次未过门槛会清连续计数', async () => {
    const h = makeHarness();
    const live = liveOf(PEER, 'dc', stubSession(), 225);
    h.state.live.set(PEER, live);
    h.coord.onRttSample(live, 225);
    live.rttMs = 20;
    h.scheduler.nowMs += 5_000;
    h.coord.onRttSample(live, 20);
    live.rttMs = 225;
    h.scheduler.nowMs += 15_000;
    h.coord.onRttSample(live, 225);
    await Promise.resolve();
    expect(h.relays).toHaveLength(0);
    h.coord.dispose();
  });

  test('direct 模式不降级', async () => {
    const h = makeHarness({ mode: 'direct' });
    const live = liveOf(PEER, 'dc', stubSession(), 800);
    h.state.live.set(PEER, live);
    h.scheduler.nowMs += 15_000;
    h.coord.onRttSample(live, 800);
    h.coord.onRttSample(live, 800);
    h.coord.onRttSample(live, 800);
    await Promise.resolve();
    expect(h.relays).toHaveLength(0);
    h.coord.dispose();
  });
});

describe('RouteDegradeCoordinator backoff', () => {
  test('降级后 2 min 内不允许再拨直连，翻倍到 30 min', async () => {
    const h = makeHarness();
    const live = liveOf(PEER, 'dc', stubSession(), 225);
    h.state.live.set(PEER, live);
    h.coord.onRttSample(live, 225);
    h.scheduler.nowMs += 15_000;
    h.coord.onRttSample(live, 225);
    h.coord.onRttSample(live, 225);
    await Promise.resolve();
    expect(h.coord.allowsOutboundDirect(PEER)).toBe(false);

    h.scheduler.nowMs += 2 * 60 * 1000 - 1;
    expect(h.coord.allowsOutboundDirect(PEER)).toBe(false);
    h.scheduler.nowMs += 1;
    expect(h.coord.allowsOutboundDirect(PEER)).toBe(true);

    const dc = stubSession();
    const decision = h.coord.interceptTrack({
      session: dc,
      peerNodeId: PEER,
      transport: 'dc',
      initiatedBy: h.state.identity.nodeId,
      gen: 1,
      remoteAddress: null,
      dcAttemptId: 'dc:1',
      prev: h.state.live.get(PEER),
    });
    expect(decision).toEqual({ action: 'hold' });
    h.coord.noteCandidateSample(PEER, 90);
    h.coord.noteCandidateSample(PEER, 90);
    h.coord.noteCandidateSample(PEER, 90);
    expect(dc.closedReason).toBe('route-measure-reject');
    expect(h.coord.allowsOutboundDirect(PEER)).toBe(false);
    h.scheduler.nowMs += 4 * 60 * 1000 - 1;
    expect(h.coord.allowsOutboundDirect(PEER)).toBe(false);
    h.scheduler.nowMs += 1;
    expect(h.coord.allowsOutboundDirect(PEER)).toBe(true);
    h.coord.dispose();
  });
});

describe('RouteDegradeCoordinator make-before-break promotion', () => {
  async function degradedRelay() {
    const h = makeHarness();
    const live = liveOf(PEER, 'dc', stubSession(), 225);
    h.state.live.set(PEER, live);
    h.coord.onRttSample(live, 225);
    h.scheduler.nowMs += 15_000;
    h.coord.onRttSample(live, 225);
    h.coord.onRttSample(live, 225);
    await Promise.resolve();
    h.scheduler.nowMs += 2 * 60 * 1000;
    const relayLive = h.state.live.get(PEER);
    expect(relayLive?.transport).toBe('relay');
    return { h, relayLive };
  }

  test('3 个足够好的样本才安装直连', async () => {
    const { h, relayLive } = await degradedRelay();
    const dc = stubSession();
    expect(
      h.coord.interceptTrack({
        session: dc,
        peerNodeId: PEER,
        transport: 'dc',
        initiatedBy: h.state.identity.nodeId,
        gen: 1,
        remoteAddress: null,
        dcAttemptId: 'dc:9',
        prev: relayLive,
      })
    ).toEqual({ action: 'hold' });
    expect(h.coord.hasCandidate(PEER)).toBe(true);
    expect(h.state.live.get(PEER)?.session).toBe(relayLive?.session);

    h.state.live.get(PEER)!.rttMs = 100;
    h.coord.noteCandidateSample(PEER, 40);
    h.coord.noteCandidateSample(PEER, 42);
    expect(h.state.live.get(PEER)?.transport).toBe('relay');
    h.coord.noteCandidateSample(PEER, 41);
    expect(h.state.live.get(PEER)?.transport).toBe('dc');
    expect(h.state.live.get(PEER)?.session).toBe(dc);
    expect(h.coord.isDegraded(PEER)).toBe(false);
    h.coord.dispose();
  });

  test('刚装上的 relay 尚无 pong 时不误判 direct，也不因 relayMs 未知拒候选', async () => {
    const { h, relayLive } = await degradedRelay();
    h.state.live.get(PEER)!.rttMs = null;
    expect(h.coord.decidePath(PEER, 'interactive')).toBe('relay');
    expect(h.coord.decidePath(PEER, 'bulk')).toBe('relay');

    const dc = stubSession();
    h.coord.interceptTrack({
      session: dc,
      peerNodeId: PEER,
      transport: 'dc',
      initiatedBy: h.state.identity.nodeId,
      gen: 1,
      remoteAddress: null,
      dcAttemptId: 'dc:9',
      prev: relayLive,
    });
    h.coord.noteCandidateSample(PEER, 2);
    h.coord.noteCandidateSample(PEER, 2);
    h.coord.noteCandidateSample(PEER, 2);
    expect(dc.closedReason).not.toBe('route-measure-reject');
    expect(h.state.live.get(PEER)?.transport).toBe('dc');
    expect(h.state.live.get(PEER)?.session).toBe(dc);
    h.coord.dispose();
  });

  test('样本不够好则关掉直连并进入回退', async () => {
    const { h, relayLive } = await degradedRelay();
    const dc = stubSession();
    h.coord.interceptTrack({
      session: dc,
      peerNodeId: PEER,
      transport: 'dc',
      initiatedBy: h.state.identity.nodeId,
      gen: 1,
      remoteAddress: null,
      dcAttemptId: 'dc:9',
      prev: relayLive,
    });
    h.state.live.get(PEER)!.rttMs = 15;
    h.coord.noteCandidateSample(PEER, 12);
    h.coord.noteCandidateSample(PEER, 11);
    h.coord.noteCandidateSample(PEER, 10);
    expect(dc.closedReason).toBe('route-measure-reject');
    expect(h.state.live.get(PEER)?.transport).toBe('relay');
    expect(h.coord.allowsOutboundDirect(PEER)).toBe(false);
    h.coord.dispose();
  });
});

describe('RouteDegradeCoordinator mode change', () => {
  test('切到 relay 立刻退役直连 live', async () => {
    const h = makeHarness();
    const dc = stubSession();
    h.state.live.set(PEER, liveOf(PEER, 'dc', dc, 20));
    h.mode.set('relay');
    await Promise.resolve();
    expect(h.relays).toHaveLength(1);
    expect(h.state.live.get(PEER)?.transport).toBe('relay');
    expect(h.coord.allowsOutboundDirect(PEER)).toBe(false);
    expect(h.coord.allowsInboundDirect()).toBe(false);
    h.coord.dispose();
  });

  test('切到 direct 立刻允许升级并清回退', async () => {
    const h = makeHarness();
    const live = liveOf(PEER, 'dc', stubSession(), 225);
    h.state.live.set(PEER, live);
    h.coord.onRttSample(live, 225);
    h.scheduler.nowMs += 15_000;
    h.coord.onRttSample(live, 225);
    h.coord.onRttSample(live, 225);
    await Promise.resolve();
    expect(h.coord.allowsOutboundDirect(PEER)).toBe(false);
    h.mode.set('direct');
    expect(h.coord.allowsOutboundDirect(PEER)).toBe(true);
    expect(h.upgrades).toContain(PEER);
    h.coord.dispose();
  });

  test('openRelay 等待期间切到 direct 后，迟到的 relay 不安装并关掉', async () => {
    let release!: (session: LinkSession) => void;
    const hanging = new Promise<LinkSession>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({ openRelay: () => hanging });
    const dc = stubSession();
    h.state.live.set(PEER, liveOf(PEER, 'dc', dc, 225));
    const pending = h.coord.degradeToRelay(PEER);

    const direct = stubSession();
    h.state.live.set(PEER, liveOf(PEER, 'dc', direct, 8));
    h.mode.set('direct');
    expect(h.state.live.get(PEER)?.session).toBe(direct);

    const late = stubSession();
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      release(late);
      await pending;
    } finally {
      console.log = orig;
    }

    expect(h.installed.some((row) => row.session === late)).toBe(false);
    expect(h.state.live.get(PEER)?.session).toBe(direct);
    expect(h.state.live.get(PEER)?.transport).toBe('dc');
    expect(late.closedReason).toBe('route_switch_abandoned');
    expect(lines.some((row) => row.includes('route_switch_abandoned'))).toBe(true);
    h.coord.dispose();
  });

  test('切到 auto 重置回退', async () => {
    const h = makeHarness({ mode: 'direct' });
    const live = liveOf(PEER, 'relay', stubSession(), 15);
    h.state.live.set(PEER, live);
    h.mode.set('relay');
    await Promise.resolve();
    h.mode.set('auto');
    expect(h.coord.allowsOutboundDirect(PEER)).toBe(true);
    expect(h.coord.isDegraded(PEER)).toBe(false);
    expect(h.upgrades).toContain(PEER);
    h.coord.dispose();
  });
});

describe('RouteDegradeCoordinator inbound direct in relay mode', () => {
  test('relay 模式入站 dc/ws-secure 拒绝安装', () => {
    const h = makeHarness({ mode: 'relay' });
    const relay = stubSession();
    h.state.live.set(PEER, liveOf(PEER, 'relay', relay, 15));
    const dc = stubSession();
    const decision = h.coord.interceptTrack({
      session: dc,
      peerNodeId: PEER,
      transport: 'dc',
      initiatedBy: PEER,
      gen: 1,
      remoteAddress: null,
      dcAttemptId: 'dc:1',
      prev: h.state.live.get(PEER),
    });
    expect(decision).toEqual({ action: 'reject', reason: 'route-relay' });
    expect(
      h.coord.interceptTrack({
        session: stubSession(),
        peerNodeId: PEER,
        transport: 'ws-secure',
        initiatedBy: PEER,
        gen: 1,
        remoteAddress: null,
        dcAttemptId: null,
        prev: h.state.live.get(PEER),
      }).action
    ).toBe('reject');
    h.coord.dispose();
  });

  test('auto 未降级时入站直连继续走原 rank（兼容 2.3.7 / 现有测试）', () => {
    const h = makeHarness();
    const relay = stubSession();
    h.state.live.set(PEER, liveOf(PEER, 'relay', relay, 15));
    expect(
      h.coord.interceptTrack({
        session: stubSession(),
        peerNodeId: PEER,
        transport: 'dc',
        initiatedBy: PEER,
        gen: 1,
        remoteAddress: null,
        dcAttemptId: 'dc:1',
        prev: h.state.live.get(PEER),
      })
    ).toEqual({ action: 'continue' });
    h.coord.dispose();
  });
});

describe('RouteDegradeCoordinator decidePath', () => {
  test('三模式与 live 一致', () => {
    const auto = makeHarness({ mode: 'auto' });
    auto.state.live.set(PEER, liveOf(PEER, 'dc', stubSession(), 20));
    expect(auto.coord.decidePath(PEER, 'interactive')).toBe('direct');
    expect(auto.coord.decidePath(PEER, 'bulk')).toBe('direct');
    auto.coord.dispose();

    const relay = makeHarness({ mode: 'relay' });
    relay.state.live.set(PEER, liveOf(PEER, 'dc', stubSession(), 20));
    expect(relay.coord.decidePath(PEER, 'interactive')).toBe('relay');
    relay.coord.dispose();

    const direct = makeHarness({ mode: 'direct' });
    direct.state.live.set(PEER, liveOf(PEER, 'relay', stubSession(), 15));
    expect(direct.coord.decidePath(PEER, 'interactive')).toBe('direct');
    direct.coord.dispose();
  });
});

describe('RouteDegradeCoordinator intercept hold uses a real mux', () => {
  test('hold 不会关掉候选 session', async () => {
    const h = makeHarness();
    const live = liveOf(PEER, 'dc', stubSession(), 225);
    h.state.live.set(PEER, live);
    h.coord.onRttSample(live, 225);
    h.scheduler.nowMs += 15_000;
    h.coord.onRttSample(live, 225);
    h.coord.onRttSample(live, 225);
    await Promise.resolve();
    h.scheduler.nowMs += 2 * 60 * 1000;
    const [local] = createInMemoryLinkPair();
    const decision = h.coord.interceptTrack({
      session: local,
      peerNodeId: PEER,
      transport: 'dc',
      initiatedBy: h.state.identity.nodeId,
      gen: 1,
      remoteAddress: null,
      dcAttemptId: 'dc:2',
      prev: h.state.live.get(PEER),
    });
    expect(decision.action).toBe('hold');
    expect(h.coord.hasCandidate(PEER)).toBe(true);
    h.coord.dispose();
  });

  test('对端关掉测量候选时取消 pingTimer', async () => {
    const h = makeHarness();
    const live = liveOf(PEER, 'dc', stubSession(), 225);
    h.state.live.set(PEER, live);
    h.coord.onRttSample(live, 225);
    h.scheduler.nowMs += 15_000;
    h.coord.onRttSample(live, 225);
    h.coord.onRttSample(live, 225);
    await Promise.resolve();
    h.scheduler.nowMs += 2 * 60 * 1000;
    const [local] = createInMemoryLinkPair();
    h.coord.interceptTrack({
      session: local,
      peerNodeId: PEER,
      transport: 'dc',
      initiatedBy: h.state.identity.nodeId,
      gen: 1,
      remoteAddress: null,
      dcAttemptId: 'dc:2',
      prev: h.state.live.get(PEER),
    });
    expect(h.coord.hasCandidate(PEER)).toBe(true);
    expect(h.scheduler.intervals.some((row) => !row.cleared)).toBe(true);
    local.close('peer-closed');
    await local.closed;
    await Promise.resolve();
    expect(h.coord.hasCandidate(PEER)).toBe(false);
    expect(h.scheduler.intervals.every((row) => row.cleared)).toBe(true);
    h.coord.dispose();
  });
});
