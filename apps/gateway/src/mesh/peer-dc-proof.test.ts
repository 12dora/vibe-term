import { afterEach, describe, expect, test } from 'bun:test';
import { type LinkSession, createInMemoryLinkPair } from '@vibeterm/shared/link';
import { encodeCtlMessage } from './ctl';
import { UnstableDcBackoff, isLiveDcProven, isPostEstablishDcLoss } from './peer-dc-proof';
import { noteDialDcFailure } from './peer-dialer-dc-gate';
import { PeerEndpointBackoff } from './peer-endpoint-backoff';
import { PeerLinkDrain } from './peer-link-drain';
import { PeerLiveRegistry } from './peer-live-registry';
import {
  DC_UNSTABLE_BACKOFF_MS,
  DC_UNSTABLE_STRIKES,
  DC_UNSTABLE_WINDOW_MS,
  PEER_RETIRE_MAX_MS,
  PEER_RETIRE_MIN_MS,
  createPeerManagerState,
} from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';
import { resetDcLinkProofForTests } from './rtc/dc-link-proof';
import { ImmediateScheduler } from './test-support';
import type { MeshIdentity, PeerTransportKind } from './types';

const SELF = 'aa'.repeat(16);
const PEER = 'bb'.repeat(16);

afterEach(() => {
  resetDcLinkProofForTests();
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type FailureCall = { kind: string; attempt?: string };
type UnstableCall = { peer: string; cooldownMs: number };

function makeHarness() {
  const scheduler = new ImmediateScheduler();
  const identity = { nodeId: SELF, edSecretKey: new Uint8Array(64) } as MeshIdentity;
  const state = createPeerManagerState({
    identity,
    userStore: {
      getCert: () => ({ userId: 'user-1', revokedLogSeq: null }),
    } as never,
    uplink: { userId: 'user-1', rttMs: null, resetBackoff() {} } as never,
    scheduler,
    endpointBackoff: new PeerEndpointBackoff({ now: () => scheduler.now() }),
  });
  const failures: FailureCall[] = [];
  const unstableCalls: UnstableCall[] = [];
  const established: string[] = [];
  const gates = new Map<
    string,
    { failures: number; nextEligibleAt: number; coalesced: boolean; scheduled: boolean }
  >();
  const wakes = new Map<
    string,
    { nextEligibleAt: number; verifyTokens: number; verifyRefillAt: number }
  >();
  const sendCtl = (live: LivePeer, msg: Record<string, unknown>) => {
    live.session.ctl.send(encodeCtlMessage(msg as { t: string }));
  };
  const late: { registry?: PeerLiveRegistry } = {};
  const drain = new PeerLinkDrain(state, {
    clearIdle: (live) => late.registry?.clearIdle(live),
    sendPeerCtl: sendCtl,
    maybeUpgrade: () => {},
    armDcUpgradeRetry: () => {},
    onPeerReconnected: () => {},
    hasCoalescedUpgrade: () => false,
    extraHelloCaps: () => [],
    noteHelloCaps: () => {},
    onRerollRequest: () => {},
    track: (...args) => late.registry?.track(...args) ?? null,
  });
  const breaker = {
    noteFailure: (_peer: string, kind: string, attemptId?: string) => {
      failures.push({ kind, attempt: attemptId });
    },
    noteUnstable: (peer: string, cooldownMs: number) => {
      unstableCalls.push({ peer, cooldownMs });
    },
    noteChannelEstablished: (_peer: string, attemptId?: string) => {
      if (attemptId) established.push(attemptId);
    },
    isDisabled: () => false,
    snapshot: () => ({
      cooling: false,
      until: null,
      failures: 0,
      level: 0,
      lastFailureKind: null,
      disabled: false,
    }),
    reset: () => {},
    shouldTry: () => ({ allow: true, cooling: false, until: null, failures: 0, level: 0 }),
    shouldAcceptAnswer: () => true,
  };
  const registry = new PeerLiveRegistry(state, {
    idleMs: 60_000,
    maxConcurrentStreams: 8,
    dispatchHttp: () => undefined,
    onGatewaySession: null,
    onGatewaySessionClose: null,
    onLinkInfo: null,
    deps: {
      dcBreaker: breaker as never,
      sendPeerCtl: sendCtl,
      handlePeerCtl: () => {},
      sendPeerStatus: () => {},
      sendLinkHello: (live) => drain.sendLinkHello(live),
      restartQuiesce: (live) => drain.restartQuiesce(live),
      probeQuiesce: (live) => drain.probeQuiesce(live),
      clearDirectFailure: () => {},
      parkInbound: (...args) => drain.parkInbound(...args),
      dropParked: (nodeId, reason) => drain.dropParked(nodeId, reason),
      activateParked: (nodeId) => drain.activateParked(nodeId),
      retirePeer: (prev, reason) => drain.retirePeer(prev, reason),
      finishRetire: (live, reason) => drain.finishRetire(live, reason),
      armRetireTimer: (live, reason) => drain.armRetireTimer(live, reason),
      maybeFinishRetire: (live, reason) => drain.maybeFinishRetire(live, reason),
      nextDcAttemptId: () => 'dc:auto',
      armDcHealthTimer: () => {},
      cancelDcHealthTimer: () => {},
      armDcUpgradeRetry: () => {},
      cancelDcUpgradeRetry: () => {},
      ensureGate: (id) => {
        let gate = gates.get(id);
        if (!gate) {
          gate = { failures: 0, nextEligibleAt: 0, coalesced: false, scheduled: false };
          gates.set(id, gate);
        }
        return gate;
      },
      ensureIncomingWakeGate: (id) => {
        let wake = wakes.get(id);
        if (!wake) {
          wake = { nextEligibleAt: 0, verifyTokens: 0, verifyRefillAt: 0 };
          wakes.set(id, wake);
        }
        return wake;
      },
      onPeerReconnected: () => {},
      notifyTransport: () => {},
      notifyLive: () => {},
      onRttSample: () => {},
    },
  });
  late.registry = registry;
  return { scheduler, state, registry, drain, failures, unstableCalls, established };
}

function installRelayThenDc(h: ReturnType<typeof makeHarness>, attempt = 'dc:1') {
  const [relay, relayPeer] = createInMemoryLinkPair();
  const [dc, dcPeer] = createInMemoryLinkPair();
  let relayReason: string | undefined;
  void relay.closed.then((info) => {
    relayReason = info.reason;
  });
  h.registry.track(relay, PEER, 'relay', SELF, 0, true);
  h.registry.track(dc, PEER, 'dc', SELF, 0, false, null, attempt);
  return {
    relay,
    relayPeer,
    dc,
    dcPeer,
    relayReason: () => relayReason,
  };
}

describe('unproven DC does not retire the previous relay', () => {
  test('zero inbound keeps the relay through the min window and a 10s close restores it', async () => {
    const h = makeHarness();
    const link = installRelayThenDc(h);
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      expect(h.state.live.get(PEER)?.transport).toBe('dc');
      expect(h.established).toEqual(['dc:1']);
      const retiring = [...(h.state.retiring.get(PEER) ?? [])];
      expect(retiring.map((row) => row.session)).toEqual([link.relay]);
      retiring[0]!.gotQuiesceAck = true;
      retiring[0]!.gotPeerQuiesce = true;
      h.drain.maybeFinishRetire(retiring[0]!);
      expect(retiring[0]!.finishRetired).toBe(false);
      expect(link.relayReason()).toBeUndefined();

      h.scheduler.advance(PEER_RETIRE_MIN_MS);
      await flush();
      expect(link.relayReason()).toBeUndefined();
      expect(h.state.live.get(PEER)?.session).toBe(link.dc);

      h.scheduler.advance(10_000 - PEER_RETIRE_MIN_MS);
      await flush();
      expect(link.relayReason()).toBeUndefined();

      link.dc.close('channel-closed');
      await flush();
      expect(h.state.live.get(PEER)?.session).toBe(link.relay);
      expect(h.state.live.get(PEER)?.transport).toBe('relay');
      expect(link.relayReason()).toBeUndefined();
      expect(h.failures).toEqual([]);
      expect(h.unstableCalls).toEqual([]);
      expect(
        lines.some((line) => line.includes('dc drop') && line.includes('reason=channel-closed'))
      ).toBe(true);
      expect(
        lines.some((line) => line.includes('proven=false') && line.includes('attempt=dc:1'))
      ).toBe(true);
    } finally {
      console.log = orig;
    }
  });

  test('a mux pong proves the DC and the relay then retires on the old timer', async () => {
    const h = makeHarness();
    const link = installRelayThenDc(h, 'dc:pong');
    link.dcPeer.ctl.send(encodeCtlMessage({ t: 'pong' }));
    await flush();
    await flush();
    const live = h.state.live.get(PEER);
    expect(live?.transport).toBe('dc');
    expect(isLiveDcProven(live!)).toBe(true);
    h.scheduler.advance(PEER_RETIRE_MIN_MS);
    await flush();
    expect(link.relayReason()).toBe('replaced');
    expect(h.state.live.get(PEER)?.session).toBe(link.dc);
    link.dc.close('liveness-timeout');
    await flush();
    expect(h.state.live.get(PEER)).toBeUndefined();
    expect(h.failures).toEqual([]);
    expect(h.unstableCalls).toEqual([]);
  });

  test('an unproven DC is retired anyway at PEER_RETIRE_MAX_MS', async () => {
    const h = makeHarness();
    const link = installRelayThenDc(h);
    h.scheduler.advance(PEER_RETIRE_MAX_MS);
    await flush();
    expect(link.relayReason()).toBe('replaced');
    expect(h.state.live.get(PEER)?.transport).toBe('dc');
  });
});

describe('established DC loss is not a dial failure', () => {
  test('pre-establish timeout is still counted', () => {
    const calls: string[] = [];
    noteDialDcFailure({
      stopped: false,
      nodeId: PEER,
      err: new Error('timeout'),
      connectP: null,
      attemptId: 'dc:pre',
      peerInitiated: false,
      dcBreaker: {
        noteFailure: (_peer, kind) => {
          calls.push(kind ?? '');
          return { counted: true, opened: false, open: false };
        },
      },
    });
    expect(calls).toEqual(['timeout']);
  });

  test('channel-closed, liveness-timeout, missed-pong and dc-promote-reject do not count; timeout does', async () => {
    const h = makeHarness();
    const reasons = [
      'channel-closed',
      'liveness-timeout',
      'missed-pong',
      'dc-promote-reject',
    ] as const;
    for (const reason of reasons) {
      const [, , dc] = trackDc(h, `dc:${reason}`);
      h.registry.dropPeer(PEER, reason);
      await flush();
      expect(h.state.live.has(PEER)).toBe(false);
      void dc;
    }
    expect(h.failures).toEqual([]);
    const dc = trackDc(h, 'dc:timeout')[2];
    h.registry.dropPeer(PEER, 'timeout');
    await flush();
    expect(h.failures).toEqual([{ kind: 'timeout', attempt: 'dc:timeout' }]);
    void dc;
  });

  test('N unproven deaths arm a short unstable backoff and do not climb the dial breaker', async () => {
    const h = makeHarness();
    for (let i = 0; i < DC_UNSTABLE_STRIKES; i += 1) {
      const [relay] = createInMemoryLinkPair();
      const [dc] = createInMemoryLinkPair();
      if (!h.state.live.has(PEER)) h.registry.track(relay, PEER, 'relay', SELF, 0, true);
      h.registry.track(dc, PEER, 'dc', SELF, 0, false, null, `dc:u${i}`);
      dc.close('channel-closed');
      await flush();
      expect(h.state.live.get(PEER)?.transport).toBe('relay');
    }
    expect(h.failures).toEqual([]);
    expect(h.unstableCalls).toEqual([{ peer: PEER, cooldownMs: DC_UNSTABLE_BACKOFF_MS }]);
  });
});

describe('UnstableDcBackoff', () => {
  test('counts only unproven deaths inside the window and clears after a proven one', () => {
    let now = 0;
    const backoff = new UnstableDcBackoff(
      () => now,
      3,
      DC_UNSTABLE_WINDOW_MS,
      DC_UNSTABLE_BACKOFF_MS
    );
    expect(backoff.note('p', false)).toBe(0);
    expect(backoff.note('p', false)).toBe(0);
    expect(backoff.note('p', true)).toBe(0);
    expect(backoff.note('p', false)).toBe(0);
    expect(backoff.note('p', false)).toBe(0);
    expect(backoff.note('p', false)).toBe(DC_UNSTABLE_BACKOFF_MS);
    now += DC_UNSTABLE_WINDOW_MS;
    expect(isPostEstablishDcLoss('channel-closed')).toBe(true);
    expect(isPostEstablishDcLoss('timeout')).toBe(false);
    expect(backoff.note('p', false)).toBe(0);
  });
});

function trackDc(
  h: ReturnType<typeof makeHarness>,
  attempt: string
): [LinkSession, LinkSession, LinkSession] {
  const [dc, dcPeer] = createInMemoryLinkPair();
  h.registry.track(dc, PEER, 'dc' as PeerTransportKind, SELF, 0, false, null, attempt);
  return [dc, dcPeer, dc];
}
