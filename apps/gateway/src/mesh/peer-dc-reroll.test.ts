import { afterEach, describe, expect, test } from 'bun:test';
import { type LinkSession, createInMemoryLinkPair } from '@vibeterm/shared/link';
import {
  DC_REROLL_MAX_PER_HOUR,
  DC_REROLL_MIN_INTERVAL_MS,
  DC_REROLL_RESULT_DEADLINE_MS,
  DC_REROLL_WINDOW_MS,
} from './dc-reroll-policy';
import type { RtcSignalMessage } from './mesh-deps';
import {
  DC_REROLL_CANDIDATE_INBOX_CAP,
  DcRerollCoordinator,
  resetDcRerollEnvLogForTest,
} from './peer-dc-reroll';
import { PeerEndpointBackoff } from './peer-endpoint-backoff';
import {
  type PeerManagerState,
  RTC_PEER_INBOX_MAX_MESSAGES,
  createPeerManagerState,
} from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';
import { RTC_SIGNAL_INBOX_TTL_MS } from './peer-rtc-wake';
import { encodeCandidateSignal, encodeSdpSignal } from './rtc/ice';
import { ImmediateScheduler } from './test-support';
import type { MeshIdentity, PeerTransportKind } from './types';

const SELF = '11'.repeat(16);
const PEER = 'ff'.repeat(16);

function makeState(selfNodeId = SELF): { state: PeerManagerState; scheduler: ImmediateScheduler } {
  const scheduler = new ImmediateScheduler();
  const identity = { nodeId: selfNodeId, edSecretKey: new Uint8Array(64) } as MeshIdentity;
  const state = createPeerManagerState({
    identity,
    userStore: { getCert: () => null } as never,
    uplink: { rttMs: null } as never,
    scheduler,
    endpointBackoff: new PeerEndpointBackoff({ now: () => scheduler.now() }),
  });
  return { state, scheduler };
}

function makeLive(
  state: PeerManagerState,
  patch: Partial<LivePeer> & { transport?: PeerTransportKind } = {}
): LivePeer {
  const live = {
    session: createInMemoryLinkPair()[0],
    peerNodeId: PEER,
    transport: 'dc' as PeerTransportKind,
    initiatedBy: SELF,
    generation: 0,
    streams: 0,
    rttMs: 200,
    rttSamples: 2,
    rttSpikeIgnored: false,
    pingSentAt: null,
    lastRttEmitAt: 0,
    lastEmittedRttMs: null,
    linkSinceAt: state.scheduler.now() - 60_000,
    quiesceCapable: true,
    rerollCapable: true,
    retiring: false,
    finishRetired: false,
    ...patch,
  } as unknown as LivePeer;
  state.live.set(live.peerNodeId, live);
  return live;
}

type Harness = {
  state: PeerManagerState;
  scheduler: ImmediateScheduler;
  coordinator: DcRerollCoordinator;
  dials: Array<{ nodeId: string; answer: boolean; transport?: string }>;
  sentCtl: Record<string, unknown>[];
  retired: Array<{ live: LivePeer; reason: string }>;
  settle: (session: LinkSession | null) => void;
  inflight: Set<string>;
  wsInflight: Set<string>;
  breaker: { allow: boolean };
  dcCapable: { value: boolean };
  willAttempt: { value: boolean };
  answererAllows: { value: boolean };
  dialMode: { result: 'hang' | null };
};

function captureLogs(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

function harness(selfNodeId = SELF): Harness {
  const { state, scheduler } = makeState(selfNodeId);
  const dials: Harness['dials'] = [];
  const sentCtl: Harness['sentCtl'] = [];
  const retired: Harness['retired'] = [];
  const inflight = new Set<string>();
  const wsInflight = new Set<string>();
  const breaker = { allow: true };
  const dcCapable = { value: false };
  const willAttempt = { value: false };
  const answererAllows = { value: true };
  const dialMode: Harness['dialMode'] = { result: 'hang' };
  let settle: (session: LinkSession | null) => void = () => {};
  const coordinator = new DcRerollCoordinator(state, {
    breakerAllows: () => breaker.allow,
    hasDcInflight: (nodeId) => inflight.has(nodeId),
    hasWsRerollInflight: (nodeId) => wsInflight.has(nodeId),
    dcCapable: () => dcCapable.value,
    willAttemptUpgrade: () => willAttempt.value,
    answererAllows: () => answererAllows.value,
    dialReroll: (nodeId, opts) => {
      dials.push({ nodeId, answer: opts.answer, transport: opts.transport });
      if (dialMode.result === null) return Promise.resolve(null);
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
    finishRetire: (live, reason) => retired.push({ live, reason }),
    sendPeerCtl: (_live, msg) => {
      sentCtl.push(msg);
    },
  });
  return {
    state,
    scheduler,
    coordinator,
    dials,
    sentCtl,
    retired,
    settle: (session) => settle(session),
    inflight,
    wsInflight,
    breaker,
    dcCapable,
    willAttempt,
    answererAllows,
    dialMode,
  };
}

function offer(epoch = 4_096): RtcSignalMessage {
  return {
    rtcSession: 'dc',
    from: 'node',
    to: SELF,
    sdp: encodeSdpSignal({ type: 'offer', sdp: 'v=0', epoch }),
    candidate: null,
  };
}

describe('DcRerollCoordinator 采样与触发', () => {
  afterEach(() => {
    process.env.VIBETERM_DC_REROLL = undefined;
    resetDcRerollEnvLogForTest();
  });

  test('dc / ws-secure 的样本进记忆，relay 不进；样本计数逐条累加', () => {
    const h = harness();
    const dc = makeLive(h.state, { rttSamples: 0 });
    h.coordinator.onRttSample(dc, 90);
    const ws = makeLive(h.state, {
      peerNodeId: 'cd'.repeat(16),
      transport: 'ws-secure',
      rttSamples: 0,
    });
    h.coordinator.onRttSample(ws, 80);
    const relay = makeLive(h.state, {
      peerNodeId: 'ab'.repeat(16),
      transport: 'relay',
      rttSamples: 0,
    });
    h.coordinator.onRttSample(relay, 300);
    expect(dc.rttSamples).toBe(1);
    expect(ws.rttSamples).toBe(1);
    expect(h.state.pathRtt.samplesOf(PEER).map((s) => s.kind)).toEqual(['dc']);
    expect(h.state.pathRtt.samplesOf('cd'.repeat(16)).map((s) => s.kind)).toEqual(['ws-secure']);
    expect(h.state.pathRtt.samplesOf('ab'.repeat(16))).toHaveLength(0);
  });

  test('慢路径触发一次：记预算并起 offerer 拨号', () => {
    const h = harness();
    h.state.pathRtt.record(PEER, { kind: 'tcp-connect', rttMs: 90 });
    const live = makeLive(h.state);
    h.coordinator.onRttSample(live, 200);
    expect(h.dials).toEqual([{ nodeId: PEER, answer: false, transport: 'dc' }]);
    expect(h.state.rerolls.get(PEER)?.count).toBe(1);
  });

  test('ws-secure 慢路径同样触发，走 ws-secure 拨号', () => {
    const h = harness();
    h.state.pathRtt.record(PEER, { kind: 'tcp-connect', rttMs: 90 });
    const live = makeLive(h.state, { transport: 'ws-secure' });
    h.coordinator.onRttSample(live, 200);
    expect(h.dials).toEqual([{ nodeId: PEER, answer: false, transport: 'ws-secure' }]);
    expect(h.state.rerolls.get(PEER)?.count).toBe(1);
  });

  test('ws-secure 不要求对端 reroll 能力；非 initiator 不拨', () => {
    const h = harness();
    h.state.pathRtt.record(PEER, { kind: 'tcp-connect', rttMs: 90 });
    h.coordinator.onRttSample(
      makeLive(h.state, { transport: 'ws-secure', rerollCapable: false }),
      200
    );
    expect(h.dials).toHaveLength(1);
    const answerer = harness('ff'.repeat(16));
    answerer.state.pathRtt.record('11'.repeat(16), { kind: 'tcp-connect', rttMs: 90 });
    answerer.coordinator.onRttSample(
      makeLive(answerer.state, { peerNodeId: '11'.repeat(16), transport: 'ws-secure' }),
      200
    );
    expect(answerer.dials).toHaveLength(0);
    expect(answerer.sentCtl).toEqual([
      { t: 'link.reroll-request', transport: 'ws-secure', currentMs: 200, bestMs: 90 },
    ]);
  });

  test('forceReroll 在 DC 可拨但无升级活动时放行 ws-secure', () => {
    const h = harness();
    h.dcCapable.value = true;
    makeLive(h.state, { transport: 'ws-secure' });
    expect(h.coordinator.forceReroll(PEER)).toBe(true);
    h.state.upgrading.set(PEER, Promise.resolve(createInMemoryLinkPair()[0]));
    expect(h.coordinator.forceReroll(PEER)).toBe(false);
  });

  test('DC 可拨且熔断健康、无升级活动时允许重赛 ws-secure', () => {
    const h = harness();
    h.dcCapable.value = true;
    h.breaker.allow = true;
    h.state.pathRtt.record(PEER, { kind: 'tcp-connect', rttMs: 90 });
    h.coordinator.onRttSample(makeLive(h.state, { transport: 'ws-secure' }), 200);
    expect(h.dials).toEqual([{ nodeId: PEER, answer: false, transport: 'ws-secure' }]);
  });

  test('DC 升级在途或即将扫描拨号时不重赛 ws-secure', () => {
    const h = harness();
    h.dcCapable.value = true;
    h.state.pathRtt.record(PEER, { kind: 'tcp-connect', rttMs: 90 });
    h.inflight.add(PEER);
    h.coordinator.onRttSample(makeLive(h.state, { transport: 'ws-secure' }), 200);
    expect(h.dials).toHaveLength(0);
    h.inflight.delete(PEER);
    h.state.upgrading.set(PEER, Promise.resolve(createInMemoryLinkPair()[0]));
    h.scheduler.nowMs += DC_REROLL_MIN_INTERVAL_MS;
    h.coordinator.onRttSample(makeLive(h.state, { transport: 'ws-secure' }), 200);
    expect(h.dials).toHaveLength(0);
    h.state.upgrading.delete(PEER);
    h.willAttempt.value = true;
    h.coordinator.onRttSample(makeLive(h.state, { transport: 'ws-secure' }), 200);
    expect(h.dials).toHaveLength(0);
    h.willAttempt.value = false;
    h.coordinator.onRttSample(makeLive(h.state, { transport: 'ws-secure' }), 200);
    expect(h.dials).toEqual([{ nodeId: PEER, answer: false, transport: 'ws-secure' }]);
  });

  test('DC 重掷与 ws 重赛共用每对端每小时 3 次预算', () => {
    const h = harness();
    h.state.pathRtt.record(PEER, { kind: 'tcp-connect', rttMs: 90 });
    h.coordinator.onRttSample(makeLive(h.state), 200);
    h.scheduler.nowMs += DC_REROLL_MIN_INTERVAL_MS;
    h.coordinator.onRttSample(makeLive(h.state, { transport: 'ws-secure' }), 200);
    h.scheduler.nowMs += DC_REROLL_MIN_INTERVAL_MS;
    h.coordinator.onRttSample(makeLive(h.state), 200);
    expect(h.dials.map((d) => d.transport)).toEqual(['dc', 'ws-secure', 'dc']);
    h.scheduler.nowMs += DC_REROLL_MIN_INTERVAL_MS;
    h.coordinator.onRttSample(makeLive(h.state, { transport: 'ws-secure' }), 200);
    expect(h.dials).toHaveLength(DC_REROLL_MAX_PER_HOUR);
  });

  test('同一条链路上连续 pong 不会重复触发（cooldown 幂等）', () => {
    const h = harness();
    h.state.pathRtt.record(PEER, { kind: 'tcp-connect', rttMs: 90 });
    const live = makeLive(h.state);
    h.coordinator.onRttSample(live, 200);
    h.coordinator.onRttSample(live, 200);
    h.coordinator.onRttSample(live, 200);
    expect(h.dials).toHaveLength(1);
    expect(h.state.rerolls.get(PEER)?.count).toBe(1);
    h.scheduler.nowMs += DC_REROLL_MIN_INTERVAL_MS;
    h.coordinator.onRttSample(live, 200);
    expect(h.dials).toHaveLength(2);
  });

  test('滚动小时预算耗尽后拦住，窗口过期自动重开（旧实现停在 windowStartedAt 不变而失效）', () => {
    const h = harness();
    h.state.pathRtt.record(PEER, { kind: 'tcp-connect', rttMs: 90 });
    const live = makeLive(h.state);
    for (let i = 0; i < DC_REROLL_MAX_PER_HOUR + 2; i += 1) {
      h.coordinator.onRttSample(live, 200);
      h.scheduler.nowMs += DC_REROLL_MIN_INTERVAL_MS;
    }
    expect(h.dials).toHaveLength(DC_REROLL_MAX_PER_HOUR);
    const rec = h.state.rerolls.get(PEER);
    expect(rec?.count).toBe(DC_REROLL_MAX_PER_HOUR);
    // 窗口起点自触发那刻算起：走满一小时后预算归零、窗口重开。
    h.scheduler.nowMs = (rec?.windowStartedAt ?? 0) + DC_REROLL_WINDOW_MS;
    // 预算窗 1 h 长于路径 RTT 滑动窗 30 min：过期的 90 ms 样本要重新写入，否则 best 被 200 ms 顶掉。
    h.state.pathRtt.record(PEER, { kind: 'tcp-connect', rttMs: 90 });
    h.coordinator.onRttSample(live, 200);
    expect(h.dials).toHaveLength(DC_REROLL_MAX_PER_HOUR + 1);
    expect(h.state.rerolls.get(PEER)?.count).toBe(1);
    expect(h.state.rerolls.get(PEER)?.windowStartedAt).toBe(h.scheduler.nowMs);
  });

  test('对端没报 reroll 能力 / 本端不是 offerer 时不拨', () => {
    const h = harness();
    h.state.pathRtt.record(PEER, { kind: 'tcp-connect', rttMs: 90 });
    h.coordinator.onRttSample(makeLive(h.state, { rerollCapable: false }), 200);
    expect(h.dials).toHaveLength(0);
    expect(h.sentCtl).toHaveLength(0);
    const answerer = harness('ff'.repeat(16));
    answerer.state.pathRtt.record('11'.repeat(16), { kind: 'tcp-connect', rttMs: 90 });
    const live = makeLive(answerer.state, { peerNodeId: '11'.repeat(16) });
    answerer.coordinator.onRttSample(live, 200);
    expect(answerer.dials).toHaveLength(0);
    expect(answerer.sentCtl).toHaveLength(1);
  });

  test('应答侧慢路径发 reroll-request，冷却内只发一次', () => {
    const h = harness('ff'.repeat(16));
    const peerId = '11'.repeat(16);
    h.state.pathRtt.record(peerId, { kind: 'tcp-connect', rttMs: 90 });
    const live = makeLive(h.state, { peerNodeId: peerId });
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      h.coordinator.onRttSample(live, 200);
      h.coordinator.onRttSample(live, 200);
    } finally {
      console.log = orig;
    }
    expect(h.dials).toHaveLength(0);
    expect(h.sentCtl).toEqual([
      { t: 'link.reroll-request', transport: 'dc', currentMs: 200, bestMs: 90 },
    ]);
    expect(h.state.rerolls.get(peerId)?.count).toBe(1);
    expect(h.state.rerolls.get(peerId)?.pendingPeerRequest).toBe(true);
    expect(h.state.rerolls.get(peerId)?.prevSession).toBeNull();
    const line = lines.find((row) => row.includes('reroll_request'));
    expect(line).toContain(`peer=${peerId.slice(0, 8)}`);
    expect(line).toContain('transport=dc');
    expect(line).toContain('cur_ms=200');
    expect(line).toContain('best_ms=90');
    expect(line).toContain('try=1/3');
    h.scheduler.nowMs += DC_REROLL_MIN_INTERVAL_MS;
    h.coordinator.onRttSample(live, 200);
    expect(h.sentCtl).toHaveLength(2);
    expect(h.state.rerolls.get(peerId)?.count).toBe(2);
  });

  test('对端没报 reroll 能力时应答侧不发 request', () => {
    const h = harness('ff'.repeat(16));
    const peerId = '11'.repeat(16);
    h.state.pathRtt.record(peerId, { kind: 'tcp-connect', rttMs: 90 });
    h.coordinator.onRttSample(makeLive(h.state, { peerNodeId: peerId, rerollCapable: false }), 200);
    expect(h.sentCtl).toHaveLength(0);
    expect(h.dials).toHaveLength(0);
  });

  test('日志带 transport= 字段', () => {
    const h = harness();
    h.state.pathRtt.record(PEER, { kind: 'tcp-connect', rttMs: 90 });
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      h.coordinator.onRttSample(makeLive(h.state, { transport: 'ws-secure' }), 200);
    } finally {
      console.log = orig;
    }
    const line = lines.find((row) => row.includes(' reroll '));
    expect(line).toContain('transport=ws-secure');
    expect(line).toContain('reason=slow-path');
    expect(line).toContain(`peer=${PEER.slice(0, 8)}`);
  });

  test('VIBETERM_DC_REROLL=off 既不触发也不报能力位', () => {
    process.env.VIBETERM_DC_REROLL = 'off';
    const h = harness();
    h.state.pathRtt.record(PEER, { kind: 'tcp-connect', rttMs: 90 });
    const live = makeLive(h.state);
    h.coordinator.onRttSample(live, 200);
    expect(h.dials).toHaveLength(0);
    expect(h.coordinator.helloCaps()).toEqual([]);
    // 采样照常，关的只是重掷
    expect(h.state.pathRtt.bestMs(PEER)).toBe(90);
    process.env.VIBETERM_DC_REROLL = 'on';
    expect(h.coordinator.helloCaps()).toEqual(['reroll']);
  });
});

describe('DcRerollCoordinator 结算与搬流', () => {
  afterEach(() => {
    process.env.VIBETERM_DC_REROLL = undefined;
    resetDcRerollEnvLogForTest();
  });

  function triggered(): { h: Harness; old: LivePeer } {
    const h = harness();
    h.state.pathRtt.record(PEER, { kind: 'tcp-connect', rttMs: 90 });
    const old = makeLive(h.state);
    h.coordinator.onRttSample(old, 200);
    return { h, old };
  }

  test('拨失败：旧链路原地不动，预算已消耗，不再等结算', async () => {
    const { h, old } = triggered();
    h.settle(null);
    await Promise.resolve();
    expect(h.state.live.get(PEER)).toBe(old);
    expect(h.state.rerolls.get(PEER)?.count).toBe(1);
    expect(h.state.rerolls.get(PEER)?.prevSession).toBeNull();
    // 换上一条新链路也不会补发结算
    h.scheduler.nowMs += DC_REROLL_MIN_INTERVAL_MS;
    const next = makeLive(h.state, {
      rttSamples: 3,
      rttMs: 90,
      linkSinceAt: h.scheduler.nowMs,
    });
    h.coordinator.onRttSample(next, 90);
    expect(h.retired).toHaveLength(0);
  });

  test('新链路攒够 3 个样本才结算；提升 ≥30% 时把旧链路在途流搬过去', () => {
    const { h, old } = triggered();
    old.streams = 2;
    old.retiring = true;
    h.state.retiring.set(PEER, new Set([old]));
    const next = makeLive(h.state, {
      rttSamples: 0,
      rttMs: 90,
      linkSinceAt: h.scheduler.nowMs,
    });
    h.coordinator.onRttSample(next, 90);
    h.coordinator.onRttSample(next, 90);
    expect(h.retired).toHaveLength(0);
    h.coordinator.onRttSample(next, 90);
    expect(h.retired).toEqual([{ live: old, reason: 'retired' }]);
    expect(h.state.rerolls.get(PEER)?.prevSession).toBeNull();
  });

  test('超过结算时限还没换上新链路：放弃这一轮，不把后来的 dc 当成重掷成果', () => {
    const { h, old } = triggered();
    old.streams = 1;
    old.retiring = true;
    h.state.retiring.set(PEER, new Set([old]));
    h.scheduler.nowMs += DC_REROLL_RESULT_DEADLINE_MS + 1;
    const next = makeLive(h.state, {
      rttSamples: 3,
      rttMs: 10,
      linkSinceAt: h.scheduler.nowMs,
    });
    h.coordinator.onRttSample(next, 10);
    expect(h.retired).toHaveLength(0);
    expect(h.state.rerolls.get(PEER)?.prevSession).toBeNull();
  });

  test('ws-secure 新链路攒够样本后同样结算并搬流', () => {
    const h = harness();
    h.state.pathRtt.record(PEER, { kind: 'tcp-connect', rttMs: 90 });
    const old = makeLive(h.state, { transport: 'ws-secure' });
    h.coordinator.onRttSample(old, 200);
    old.streams = 1;
    old.retiring = true;
    h.state.retiring.set(PEER, new Set([old]));
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const next = makeLive(h.state, {
        transport: 'ws-secure',
        rttSamples: 0,
        rttMs: 90,
        linkSinceAt: h.scheduler.nowMs,
      });
      h.coordinator.onRttSample(next, 90);
      h.coordinator.onRttSample(next, 90);
      h.coordinator.onRttSample(next, 90);
    } finally {
      console.log = orig;
    }
    expect(h.retired).toEqual([{ live: old, reason: 'retired' }]);
    expect(
      lines.some((row) => row.includes('reroll_result') && row.includes('transport=ws-secure'))
    ).toBe(true);
    expect(
      lines.some((row) => row.includes('reroll_rehome') && row.includes('transport=ws-secure'))
    ).toBe(true);
  });

  test('新链路没快多少就只记结果，不动在途流', () => {
    const { h, old } = triggered();
    old.streams = 1;
    old.retiring = true;
    h.state.retiring.set(PEER, new Set([old]));
    const next = makeLive(h.state, {
      rttSamples: 2,
      rttMs: 190,
      linkSinceAt: h.scheduler.nowMs,
    });
    h.coordinator.onRttSample(next, 190);
    expect(h.retired).toHaveLength(0);
    expect(h.state.rerolls.get(PEER)?.prevSession).toBeNull();
  });
});

describe('DcRerollCoordinator 应答侧', () => {
  afterEach(() => {
    process.env.VIBETERM_DC_REROLL = undefined;
    resetDcRerollEnvLogForTest();
  });

  test('对端报过 reroll 能力时接管 offer：入队并起应答拨号', () => {
    const h = harness('ff'.repeat(16));
    const peerId = '11'.repeat(16);
    makeLive(h.state, { peerNodeId: peerId });
    expect(h.coordinator.interceptOffer(peerId, offer())).toBe(true);
    expect(h.dials).toEqual([{ nodeId: peerId, answer: true, transport: 'dc' }]);
    expect(h.state.rtcInbox.get(peerId)).toHaveLength(1);
  });

  test('对端没报能力 / 已有 DC 在途 / 当前不是 dc 时交回常规投递', () => {
    const h = harness('ff'.repeat(16));
    const peerId = '11'.repeat(16);
    const live = makeLive(h.state, { peerNodeId: peerId, rerollCapable: false });
    expect(h.coordinator.interceptOffer(peerId, offer())).toBe(false);
    live.rerollCapable = true;
    h.inflight.add(peerId);
    expect(h.coordinator.interceptOffer(peerId, offer())).toBe(false);
    h.inflight.delete(peerId);
    live.transport = 'relay';
    expect(h.coordinator.interceptOffer(peerId, offer())).toBe(false);
  });

  test('epoch 不高于 live.rtcEpoch 的迟到 offer 不接管、不耗预算', () => {
    const h = harness('ff'.repeat(16));
    const peerId = '11'.repeat(16);
    makeLive(h.state, { peerNodeId: peerId, rtcEpoch: 9 });
    expect(h.coordinator.interceptOffer(peerId, offer(9))).toBe(false);
    expect(h.coordinator.interceptOffer(peerId, offer(3))).toBe(false);
    expect(h.dials).toHaveLength(0);
    expect(h.state.rerolls.get(peerId)?.count ?? 0).toBe(0);
    expect(h.coordinator.interceptOffer(peerId, offer(10))).toBe(true);
  });

  test('answer 不是 offer 不接管；接更高 epoch offer 不受 request 预算限制', () => {
    const h = harness('ff'.repeat(16));
    const peerId = '11'.repeat(16);
    makeLive(h.state, { peerNodeId: peerId });
    const answer: RtcSignalMessage = {
      ...offer(),
      sdp: encodeSdpSignal({ type: 'answer', sdp: 'v=0', epoch: 4_096 }),
    };
    expect(h.coordinator.interceptOffer(peerId, answer)).toBe(false);
    for (let i = 0; i < DC_REROLL_MAX_PER_HOUR; i += 1) {
      expect(h.coordinator.interceptOffer(peerId, offer())).toBe(true);
    }
    expect(h.coordinator.interceptOffer(peerId, offer())).toBe(true);
    expect(h.dials).toHaveLength(DC_REROLL_MAX_PER_HOUR + 1);
  });

  test('发出 request 后对端 offer 不二次记预算，满预算仍接管', () => {
    const h = harness('ff'.repeat(16));
    const peerId = '11'.repeat(16);
    h.state.pathRtt.record(peerId, { kind: 'tcp-connect', rttMs: 90 });
    const live = makeLive(h.state, { peerNodeId: peerId });
    h.coordinator.onRttSample(live, 200);
    const rec = h.state.rerolls.get(peerId);
    expect(rec?.count).toBe(1);
    rec!.count = DC_REROLL_MAX_PER_HOUR;
    expect(h.coordinator.interceptOffer(peerId, offer())).toBe(true);
    expect(h.state.rerolls.get(peerId)?.count).toBe(DC_REROLL_MAX_PER_HOUR);
    expect(h.state.rerolls.get(peerId)?.pendingPeerRequest).toBe(false);
    expect(h.dials).toEqual([{ nodeId: peerId, answer: true, transport: 'dc' }]);
  });

  test('answerer backoff 中应答本端 reroll-request 的更高 epoch offer 仍起拨', () => {
    const h = harness('ff'.repeat(16));
    const peerId = '11'.repeat(16);
    h.answererAllows.value = false;
    h.state.pathRtt.record(peerId, { kind: 'tcp-connect', rttMs: 90 });
    const live = makeLive(h.state, { peerNodeId: peerId, rtcEpoch: 9 });
    h.coordinator.onRttSample(live, 200);
    expect(h.sentCtl.some((row) => row.t === 'link.reroll-request')).toBe(true);
    expect(h.state.rerolls.get(peerId)?.pendingPeerRequest).toBe(true);
    expect(h.coordinator.interceptOffer(peerId, offer(10))).toBe(true);
    expect(h.dials).toEqual([{ nodeId: peerId, answer: true, transport: 'dc' }]);
  });

  test('answerer backoff 中未请求的 offer 仍 cooldown；结果窗口过期后不再绕过', () => {
    const h = harness('ff'.repeat(16));
    const peerId = '11'.repeat(16);
    makeLive(h.state, { peerNodeId: peerId, rtcEpoch: 9 });
    h.answererAllows.value = false;
    expect(h.coordinator.interceptOffer(peerId, offer(10))).toBe(false);
    expect(h.dials).toHaveLength(0);

    h.state.rerolls.set(peerId, {
      count: 1,
      windowStartedAt: h.scheduler.nowMs,
      lastAt: h.scheduler.nowMs,
      oldMs: null,
      prevSession: null,
      transport: 'dc',
      pendingPeerRequest: true,
    });
    h.scheduler.nowMs += DC_REROLL_RESULT_DEADLINE_MS + 1;
    expect(h.coordinator.interceptOffer(peerId, offer(10))).toBe(false);
    expect(h.dials).toHaveLength(0);
  });

  test('满预算且超过 90s 窗口仍起 dialReroll({answer:true})', () => {
    const h = harness('ff'.repeat(16));
    const peerId = '11'.repeat(16);
    makeLive(h.state, { peerNodeId: peerId });
    h.state.rerolls.set(peerId, {
      count: DC_REROLL_MAX_PER_HOUR,
      windowStartedAt: h.scheduler.nowMs,
      lastAt: h.scheduler.nowMs,
      oldMs: null,
      prevSession: null,
      transport: 'dc',
      pendingPeerRequest: false,
    });
    h.scheduler.nowMs += DC_REROLL_RESULT_DEADLINE_MS + 1;
    expect(h.coordinator.interceptOffer(peerId, offer())).toBe(true);
    expect(h.dials).toEqual([{ nodeId: peerId, answer: true, transport: 'dc' }]);
  });

  test('offerer inflight 忽略 request 时，answerer 仍接管随后的 offer', () => {
    const offerer = harness();
    const peerId = PEER;
    const live = makeLive(offerer.state);
    offerer.inflight.add(peerId);
    offerer.coordinator.handlePeerRequest(live, {
      t: 'link.reroll-request',
      transport: 'dc',
      currentMs: 190,
      bestMs: 90,
    });
    expect(offerer.dials).toHaveLength(0);

    const answerer = harness('ff'.repeat(16));
    const from = '11'.repeat(16);
    makeLive(answerer.state, { peerNodeId: from });
    answerer.state.rerolls.set(from, {
      count: DC_REROLL_MAX_PER_HOUR,
      windowStartedAt: answerer.scheduler.nowMs,
      lastAt: answerer.scheduler.nowMs - DC_REROLL_RESULT_DEADLINE_MS - 1,
      oldMs: null,
      prevSession: null,
      transport: 'dc',
      pendingPeerRequest: true,
    });
    expect(answerer.coordinator.interceptOffer(from, offer())).toBe(true);
    expect(answerer.dials).toEqual([{ nodeId: from, answer: true, transport: 'dc' }]);
  });

  test('interceptOffer 拒绝打 info reroll_offer_ignored reason=', () => {
    const answerer = harness('ff'.repeat(16));
    const peerId = '11'.repeat(16);
    const live = makeLive(answerer.state, { peerNodeId: peerId, rtcEpoch: 9 });
    const epochLines = captureLogs(() => {
      expect(answerer.coordinator.interceptOffer(peerId, offer(9))).toBe(false);
    });
    expect(epochLines.some((row) => row.includes('reason=epoch'))).toBe(true);

    live.rerollCapable = false;
    const capLines = captureLogs(() => {
      expect(answerer.coordinator.interceptOffer(peerId, offer(10))).toBe(false);
    });
    expect(capLines.some((row) => row.includes('reason=not-capable'))).toBe(true);
    live.rerollCapable = true;

    answerer.inflight.add(peerId);
    const inflightLines = captureLogs(() => {
      expect(answerer.coordinator.interceptOffer(peerId, offer(10))).toBe(false);
    });
    expect(inflightLines.some((row) => row.includes('reason=inflight'))).toBe(true);
    answerer.inflight.delete(peerId);

    answerer.answererAllows.value = false;
    const coolLines = captureLogs(() => {
      expect(answerer.coordinator.interceptOffer(peerId, offer(10))).toBe(false);
    });
    expect(coolLines.some((row) => row.includes('reason=cooldown'))).toBe(true);
    answerer.answererAllows.value = true;

    const offerer = harness();
    makeLive(offerer.state);
    const roleLines = captureLogs(() => {
      expect(offerer.coordinator.interceptOffer(PEER, offer())).toBe(false);
    });
    expect(roleLines.some((row) => row.includes('reason=role'))).toBe(true);

    answerer.state.rtcInbox.set(
      peerId,
      Array.from({ length: RTC_PEER_INBOX_MAX_MESSAGES }, () => ({
        message: offer(10),
        receivedAt: answerer.scheduler.now(),
      }))
    );
    const fullLines = captureLogs(() => {
      expect(answerer.coordinator.interceptOffer(peerId, offer(11))).toBe(false);
    });
    expect(fullLines.some((row) => row.includes('reason=inbox-full'))).toBe(true);
    for (const row of [
      ...epochLines,
      ...capLines,
      ...inflightLines,
      ...coolLines,
      ...roleLines,
      ...fullLines,
    ].filter((line) => line.includes('reroll_offer_ignored'))) {
      expect(row).toContain('peer=');
      expect(row).toContain('reason=');
    }
  });

  test('dialReroll 返回 null 时丢掉刚入队的 offer 并打日志', async () => {
    const h = harness('ff'.repeat(16));
    const peerId = '11'.repeat(16);
    makeLive(h.state, { peerNodeId: peerId });
    h.dialMode.result = null;
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      expect(h.coordinator.interceptOffer(peerId, offer())).toBe(true);
      await Promise.resolve();
    } finally {
      console.log = orig;
    }
    expect(h.state.rtcInbox.get(peerId)).toBeUndefined();
    expect(
      lines.some(
        (row) => row.includes('reroll_offer_ignored') && row.includes('reason=not-capable')
      )
    ).toBe(true);
  });
});

function rerollRequest(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { t: 'link.reroll-request', transport: 'dc', currentMs: 190, bestMs: 90, ...patch };
}

describe('DcRerollCoordinator 入站 reroll-request', () => {
  afterEach(() => {
    process.env.VIBETERM_DC_REROLL = undefined;
    resetDcRerollEnvLogForTest();
  });

  test('合法请求按 forceReroll 路径拨号，reason=peer-request，oldMs 取对端 currentMs', () => {
    const h = harness();
    makeLive(h.state);
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      h.coordinator.handlePeerRequest(h.state.live.get(PEER) as LivePeer, rerollRequest());
    } finally {
      console.log = orig;
    }
    expect(h.dials).toEqual([{ nodeId: PEER, answer: false, transport: 'dc' }]);
    expect(h.state.rerolls.get(PEER)?.count).toBe(1);
    expect(h.state.rerolls.get(PEER)?.oldMs).toBe(190);
    const line = lines.find((row) => row.includes(' reroll '));
    expect(line).toContain('reason=peer-request');
    expect(line).toContain('cur_ms=190');
    expect(line).toContain('best_ms=90');
  });

  test('重复请求 60 s 内丢掉，不论第一次是否通过校验', () => {
    const h = harness();
    makeLive(h.state);
    h.coordinator.handlePeerRequest(
      h.state.live.get(PEER) as LivePeer,
      rerollRequest({ transport: 'ws-secure' })
    );
    expect(h.dials).toHaveLength(0);
    h.coordinator.handlePeerRequest(h.state.live.get(PEER) as LivePeer, rerollRequest());
    expect(h.dials).toHaveLength(0);
    h.scheduler.nowMs += DC_REROLL_MIN_INTERVAL_MS;
    h.coordinator.handlePeerRequest(h.state.live.get(PEER) as LivePeer, rerollRequest());
    expect(h.dials).toHaveLength(1);
  });

  test('非法请求静默丢掉：非 offerer / 传输不符 / 无 quiesce / 在途 / 熔断 / 预算 / 冷却', () => {
    const answerer = harness('ff'.repeat(16));
    const peerId = '11'.repeat(16);
    makeLive(answerer.state, { peerNodeId: peerId });
    answerer.coordinator.handlePeerRequest(
      answerer.state.live.get(peerId) as LivePeer,
      rerollRequest()
    );
    expect(answerer.dials).toHaveLength(0);

    const h = harness();
    const live = makeLive(h.state);
    h.coordinator.handlePeerRequest(live, rerollRequest({ transport: 'ws-secure' }));
    expect(h.dials).toHaveLength(0);
    h.scheduler.nowMs += DC_REROLL_MIN_INTERVAL_MS;
    live.quiesceCapable = false;
    h.coordinator.handlePeerRequest(live, rerollRequest());
    expect(h.dials).toHaveLength(0);
    live.quiesceCapable = true;
    h.scheduler.nowMs += DC_REROLL_MIN_INTERVAL_MS;
    h.inflight.add(PEER);
    h.coordinator.handlePeerRequest(live, rerollRequest());
    expect(h.dials).toHaveLength(0);
    h.inflight.delete(PEER);
    h.scheduler.nowMs += DC_REROLL_MIN_INTERVAL_MS;
    h.breaker.allow = false;
    h.coordinator.handlePeerRequest(live, rerollRequest());
    expect(h.dials).toHaveLength(0);
    h.breaker.allow = true;
    h.scheduler.nowMs += DC_REROLL_MIN_INTERVAL_MS;
    h.state.rerolls.set(PEER, {
      count: DC_REROLL_MAX_PER_HOUR,
      windowStartedAt: h.scheduler.nowMs,
      lastAt: null,
      oldMs: null,
      prevSession: null,
      transport: null,
    });
    h.coordinator.handlePeerRequest(live, rerollRequest());
    expect(h.dials).toHaveLength(0);
    h.state.rerolls.set(PEER, {
      count: 1,
      windowStartedAt: h.scheduler.nowMs,
      lastAt: h.scheduler.nowMs,
      oldMs: null,
      prevSession: null,
      transport: null,
    });
    h.scheduler.nowMs += DC_REROLL_MIN_INTERVAL_MS;
    h.coordinator.handlePeerRequest(live, rerollRequest());
    expect(h.dials).toHaveLength(1);
    h.scheduler.nowMs += DC_REROLL_MIN_INTERVAL_MS - 1;
    h.coordinator.handlePeerRequest(live, rerollRequest());
    expect(h.dials).toHaveLength(1);
  });

  test('未知 ctl 形状不当作请求', () => {
    const h = harness();
    makeLive(h.state);
    h.coordinator.handlePeerRequest(h.state.live.get(PEER) as LivePeer, {
      t: 'link.reroll-please',
      transport: 'dc',
      currentMs: 190,
      bestMs: 90,
    });
    expect(h.dials).toHaveLength(0);
  });
});

function iceCandidate(epoch?: number): RtcSignalMessage {
  return {
    rtcSession: 'dc',
    from: 'node',
    to: 'ff'.repeat(16),
    sdp: null,
    candidate: encodeCandidateSignal('candidate:1 1 UDP 1 10.0.0.1 9 typ host', '0', epoch),
  };
}

describe('DcRerollCoordinator interceptCandidate', () => {
  afterEach(() => {
    process.env.VIBETERM_DC_REROLL = undefined;
    resetDcRerollEnvLogForTest();
  });

  function answerer(rtcEpoch?: number) {
    const h = harness('ff'.repeat(16));
    const peerId = '11'.repeat(16);
    const live = makeLive(h.state, {
      peerNodeId: peerId,
      ...(rtcEpoch === undefined ? {} : { rtcEpoch }),
    });
    return { h, peerId, live };
  }

  test('epoch 低于或等于 live.rtcEpoch 不入队', () => {
    const { h, peerId } = answerer(5);
    expect(h.coordinator.interceptCandidate(peerId, iceCandidate(4))).toBe(false);
    expect(h.coordinator.interceptCandidate(peerId, iceCandidate(5))).toBe(false);
    expect(h.state.rtcInbox.get(peerId)).toBeUndefined();
  });

  test('epoch 高于 live.rtcEpoch 写入 inbox，不起拨号', () => {
    const { h, peerId } = answerer(5);
    expect(h.coordinator.interceptCandidate(peerId, iceCandidate(6))).toBe(true);
    expect(h.state.rtcInbox.get(peerId)).toHaveLength(1);
    expect(h.dials).toHaveLength(0);
  });

  test('live.rtcEpoch 缺省时，未见该 epoch 的 offer 则入队', () => {
    const { h, peerId } = answerer();
    expect(h.coordinator.interceptCandidate(peerId, iceCandidate(9))).toBe(true);
    expect(h.state.rtcInbox.get(peerId)).toHaveLength(1);
  });

  test('live.rtcEpoch 缺省且 inbox 已有该 epoch 的 offer 则不再堆候选', () => {
    const { h, peerId } = answerer();
    expect(h.coordinator.interceptOffer(peerId, offer())).toBe(true);
    expect(h.coordinator.interceptCandidate(peerId, iceCandidate(4_096))).toBe(false);
    expect(h.state.rtcInbox.get(peerId)).toHaveLength(1);
  });

  test('已有应答 attempt 在途、无 epoch、非 dc、未报 reroll、开关关闭都不接管', () => {
    const { h, peerId, live } = answerer(5);
    h.inflight.add(peerId);
    expect(h.coordinator.interceptCandidate(peerId, iceCandidate(6))).toBe(false);
    h.inflight.delete(peerId);
    expect(h.coordinator.interceptCandidate(peerId, iceCandidate())).toBe(false);
    live.transport = 'ws-secure';
    expect(h.coordinator.interceptCandidate(peerId, iceCandidate(6))).toBe(false);
    live.transport = 'dc';
    live.rerollCapable = false;
    expect(h.coordinator.interceptCandidate(peerId, iceCandidate(6))).toBe(false);
    live.rerollCapable = true;
    process.env.VIBETERM_DC_REROLL = 'off';
    expect(h.coordinator.interceptCandidate(peerId, iceCandidate(6))).toBe(false);
    expect(h.state.rtcInbox.get(peerId)).toBeUndefined();
  });

  test('候选最多占 DC_REROLL_CANDIDATE_INBOX_CAP 条，之后到达的 offer 仍能入队', () => {
    const { h, peerId } = answerer(5);
    for (let i = 0; i < RTC_PEER_INBOX_MAX_MESSAGES; i += 1) {
      h.coordinator.interceptCandidate(peerId, iceCandidate(6));
    }
    expect(h.state.rtcInbox.get(peerId)).toHaveLength(DC_REROLL_CANDIDATE_INBOX_CAP);
    expect(h.coordinator.interceptOffer(peerId, offer(6))).toBe(true);
    expect(h.state.rtcInbox.get(peerId)).toHaveLength(DC_REROLL_CANDIDATE_INBOX_CAP + 1);
  });

  test('offer 落定 epoch 后清掉按 fallback 入队、epoch 对不上的候选', () => {
    const { h, peerId } = answerer();
    expect(h.coordinator.interceptCandidate(peerId, iceCandidate(7))).toBe(true);
    expect(h.coordinator.interceptCandidate(peerId, iceCandidate(9))).toBe(true);
    expect(h.coordinator.interceptOffer(peerId, offer(9))).toBe(true);
    const inbox = h.state.rtcInbox.get(peerId) ?? [];
    expect(inbox).toHaveLength(2);
    expect(inbox.some((entry) => entry.message.sdp)).toBe(true);
  });

  test('inbox 满员后不再追加', () => {
    const { h, peerId } = answerer(5);
    h.state.rtcInbox.set(
      peerId,
      Array.from({ length: RTC_PEER_INBOX_MAX_MESSAGES }, () => ({
        message: iceCandidate(6),
        receivedAt: h.scheduler.now(),
      }))
    );
    expect(h.coordinator.interceptCandidate(peerId, iceCandidate(7))).toBe(false);
    expect(h.state.rtcInbox.get(peerId)).toHaveLength(RTC_PEER_INBOX_MAX_MESSAGES);
  });

  test('触碰 inbox 时丢掉超过 30s 的旧条目', () => {
    const { h, peerId } = answerer(5);
    h.state.rtcInbox.set(peerId, [
      { message: iceCandidate(6), receivedAt: h.scheduler.now() - RTC_SIGNAL_INBOX_TTL_MS - 1 },
    ]);
    expect(h.coordinator.interceptCandidate(peerId, iceCandidate(7))).toBe(true);
    const inbox = h.state.rtcInbox.get(peerId) ?? [];
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.message.candidate).toBe(iceCandidate(7).candidate);
  });
});
