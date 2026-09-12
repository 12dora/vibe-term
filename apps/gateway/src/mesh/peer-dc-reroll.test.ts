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
  retired: Array<{ live: LivePeer; reason: string }>;
  settle: (session: LinkSession | null) => void;
  inflight: Set<string>;
  wsInflight: Set<string>;
  breaker: { allow: boolean };
  dcCapable: { value: boolean };
  willAttempt: { value: boolean };
};

function harness(selfNodeId = SELF): Harness {
  const { state, scheduler } = makeState(selfNodeId);
  const dials: Harness['dials'] = [];
  const retired: Harness['retired'] = [];
  const inflight = new Set<string>();
  const wsInflight = new Set<string>();
  const breaker = { allow: true };
  const dcCapable = { value: false };
  const willAttempt = { value: false };
  let settle: (session: LinkSession | null) => void = () => {};
  const coordinator = new DcRerollCoordinator(state, {
    breakerAllows: () => breaker.allow,
    hasDcInflight: (nodeId) => inflight.has(nodeId),
    hasWsRerollInflight: (nodeId) => wsInflight.has(nodeId),
    dcCapable: () => dcCapable.value,
    willAttemptUpgrade: () => willAttempt.value,
    dialReroll: (nodeId, opts) => {
      dials.push({ nodeId, answer: opts.answer, transport: opts.transport });
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
    finishRetire: (live, reason) => retired.push({ live, reason }),
  });
  return {
    state,
    scheduler,
    coordinator,
    dials,
    retired,
    settle: (session) => settle(session),
    inflight,
    wsInflight,
    breaker,
    dcCapable,
    willAttempt,
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
    const answerer = harness('ff'.repeat(16));
    answerer.state.pathRtt.record('11'.repeat(16), { kind: 'tcp-connect', rttMs: 90 });
    const live = makeLive(answerer.state, { peerNodeId: '11'.repeat(16) });
    answerer.coordinator.onRttSample(live, 200);
    expect(answerer.dials).toHaveLength(0);
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

  test('应答侧同样受每小时 3 次的预算约束，answer 不是 offer 也不接管', () => {
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
    expect(h.coordinator.interceptOffer(peerId, offer())).toBe(false);
    expect(h.dials).toHaveLength(DC_REROLL_MAX_PER_HOUR);
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
