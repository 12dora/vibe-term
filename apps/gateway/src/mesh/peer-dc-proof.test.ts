import { afterEach, describe, expect, test } from 'bun:test';
import { type LinkSession, createInMemoryLinkPair } from '@vibeterm/shared/link';
import { encodeCtlMessage } from './ctl';
import {
  DC_STABLE_HOLD_CAP,
  UnstableDcBackoff,
  isLiveDcProven,
  markLiveDcProven,
  noteIncomingRouteClose,
  notePeerDcStableHold,
  peerSupportsDcStableHold,
  resetDcStableHoldForTests,
  settleEstablishedDcDrop,
  unstableCooldownMs,
} from './peer-dc-proof';
import { noteDialDcFailure } from './peer-dialer-dc-gate';
import { PeerEndpointBackoff } from './peer-endpoint-backoff';
import { PeerLinkDrain } from './peer-link-drain';
import { PeerLiveRegistry } from './peer-live-registry';
import {
  DC_MIN_STABLE_MS,
  DC_UNSTABLE_BACKOFF_MS,
  PEER_PING_INTERVAL_MS,
  PEER_RETIRE_MAX_MS,
  PEER_RETIRE_MIN_MS,
  createPeerManagerState,
} from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';
import { resetDcLinkProofForTests } from './rtc/dc-link-proof';
import { RTC_DIAL_BREAKER_HEALTHY_MS, RtcDialBreaker } from './rtc/rtc-dial-breaker';
import { ImmediateScheduler } from './test-support';
import type { MeshIdentity, PeerTransportKind } from './types';

const SELF = 'aa'.repeat(16);
const PEER = 'bb'.repeat(16);
const HTTP_OPEN = new TextEncoder().encode(
  JSON.stringify({ type: 'http', method: 'GET', path: '/' })
);

afterEach(() => {
  resetDcLinkProofForTests();
  resetDcStableHoldForTests();
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function waitForCtl(remote: LinkSession, type: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type}`)), 1_000);
    remote.ctl.onMessage((bytes) => {
      let msg: { t?: string };
      try {
        msg = JSON.parse(new TextDecoder().decode(bytes)) as { t?: string };
      } catch {
        return;
      }
      if (msg.t !== type) return;
      clearTimeout(timer);
      resolve(msg.t);
    });
  });
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
  const refusals: Array<number | null> = [];
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
    noteRemoteRefusal: (_peer: string, until: number | null) => {
      refusals.push(until);
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
  return { scheduler, state, registry, drain, failures, unstableCalls, established, refusals };
}

function installRelayThenDc(h: ReturnType<typeof makeHarness>, attempt = 'dc:1', capable = true) {
  if (capable) notePeerDcStableHold(PEER);
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
      expect(h.unstableCalls).toEqual([{ peer: PEER, cooldownMs: DC_UNSTABLE_BACKOFF_MS }]);
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

  test('an inbound ping does not prove; an answered pong retires only after the stable age', async () => {
    const h = makeHarness();
    const link = installRelayThenDc(h, 'dc:pong');
    link.dcPeer.ctl.send(encodeCtlMessage({ t: 'ping' }));
    await flush();
    expect(isLiveDcProven(h.state.live.get(PEER)!)).toBe(false);

    link.dcPeer.ctl.send(encodeCtlMessage({ t: 'pong', sentAt: 1 }));
    await flush();
    expect(isLiveDcProven(h.state.live.get(PEER)!)).toBe(false);

    h.scheduler.advance(PEER_PING_INTERVAL_MS);
    await flush();
    const live = h.state.live.get(PEER);
    expect(live?.transport).toBe('dc');
    expect(link.relayReason()).toBeUndefined();
    expect(live?.pingSentAt).not.toBeNull();
    link.dcPeer.ctl.send(encodeCtlMessage({ t: 'pong', sentAt: live?.pingSentAt }));
    await flush();
    expect(isLiveDcProven(live!)).toBe(true);
    expect(link.relayReason()).toBeUndefined();

    h.scheduler.advance(DC_MIN_STABLE_MS - PEER_PING_INTERVAL_MS);
    await flush();
    expect(link.relayReason()).toBe('replaced');
    expect(h.state.live.get(PEER)?.session).toBe(link.dc);
    link.dc.close('liveness-timeout');
    await flush();
    expect(h.state.live.get(PEER)).toBeUndefined();
    expect(h.failures).toEqual([]);
    expect(h.unstableCalls).toEqual([{ peer: PEER, cooldownMs: DC_UNSTABLE_BACKOFF_MS }]);
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

  test('capable peer: post-establish loss escalates and does not climb the dial breaker', async () => {
    const h = makeHarness();
    notePeerDcStableHold(PEER);
    const reasons = ['channel-closed', 'liveness-timeout', 'missed-pong'] as const;
    for (const reason of reasons) {
      trackDc(h, `dc:${reason}`);
      h.registry.dropPeer(PEER, reason);
      await flush();
      expect(h.state.live.has(PEER)).toBe(false);
    }
    trackDc(h, 'dc:promote');
    h.registry.dropPeer(PEER, 'dc-promote-reject');
    await flush();
    expect(h.failures).toEqual([]);
    expect(h.unstableCalls.map((call) => call.cooldownMs)).toEqual([
      unstableCooldownMs(1),
      unstableCooldownMs(2),
      unstableCooldownMs(3),
    ]);
    trackDc(h, 'dc:timeout');
    h.registry.dropPeer(PEER, 'timeout');
    await flush();
    expect(h.failures).toEqual([{ kind: 'timeout', attempt: 'dc:timeout' }]);
  });

  test('route-close makes the following channel-closed uncounted and cooled', async () => {
    const h = makeHarness();
    trackDc(h, 'dc:route');
    const live = h.state.live.get(PEER);
    expect(live).toBeTruthy();
    noteIncomingRouteClose(
      live as LivePeer,
      { reason: 'route-measure-reject', retryAfterMs: 60_000 },
      h.scheduler.now()
    );
    h.registry.dropPeer(PEER, 'channel-closed');
    await flush();
    expect(h.failures).toEqual([]);
    expect(h.unstableCalls).toEqual([]);
    expect(h.refusals).toEqual([h.scheduler.now() + 60_000]);
  });

  test('old peer: post-establish loss still counts as a dial failure', async () => {
    const h = makeHarness();
    trackDc(h, 'dc:old');
    h.registry.dropPeer(PEER, 'channel-closed');
    await flush();
    expect(h.failures).toEqual([{ kind: 'channel-closed', attempt: 'dc:old' }]);
    expect(h.unstableCalls).toEqual([]);
  });

  test('short deaths escalate 60s, 2min, 4min and do not climb the dial breaker', async () => {
    const h = makeHarness();
    notePeerDcStableHold(PEER);
    for (let i = 0; i < 3; i += 1) {
      const [relay] = createInMemoryLinkPair();
      const [dc] = createInMemoryLinkPair();
      if (!h.state.live.has(PEER)) h.registry.track(relay, PEER, 'relay', SELF, 0, true);
      h.registry.track(dc, PEER, 'dc', SELF, 0, false, null, `dc:u${i}`);
      dc.close('channel-closed');
      await flush();
      expect(h.state.live.get(PEER)?.transport).toBe('relay');
    }
    expect(h.failures).toEqual([]);
    expect(h.unstableCalls.map((call) => call.cooldownMs)).toEqual([
      unstableCooldownMs(1),
      unstableCooldownMs(2),
      unstableCooldownMs(3),
    ]);
  });
});

describe('UnstableDcBackoff', () => {
  test('every short life escalates and only noteHealthy clears', () => {
    const backoff = new UnstableDcBackoff();
    expect(backoff.noteShortLife('p', 10_000)).toBe(unstableCooldownMs(1));
    expect(backoff.noteShortLife('p', 10_000)).toBe(unstableCooldownMs(2));
    backoff.noteHealthy('p');
    expect(backoff.noteShortLife('p', 10_000)).toBe(unstableCooldownMs(1));
    expect(backoff.noteShortLife('p', RTC_DIAL_BREAKER_HEALTHY_MS)).toBe(0);
    expect(unstableCooldownMs(8)).toBe(30 * 60 * 1000);
  });
});

describe('proven DC that dies at 10s', () => {
  test('one hour of 10s deaths stays a handful and does not climb the dial breaker', () => {
    let now = 1_000_000;
    const breaker = new RtcDialBreaker({ now: () => now, disableAfter: 10 });
    const unstable = new UnstableDcBackoff();
    notePeerDcStableHold('peer-b');
    let dials = 0;
    const end = now + 60 * 60 * 1000;
    while (now < end) {
      const decision = breaker.shouldTry('peer-b', now);
      if (!decision.allow) {
        now = (decision.until ?? now) + 1;
        continue;
      }
      dials += 1;
      const id = `dc:${dials}`;
      breaker.beginAttempt('peer-b', id);
      now += 2_000;
      breaker.noteChannelEstablished('peer-b', id, now);
      const openedAt = now;
      const live = {
        peerNodeId: 'peer-b',
        transport: 'dc',
        linkSinceAt: openedAt,
      } as LivePeer;
      markLiveDcProven(live);
      now += 10_100;
      settleEstablishedDcDrop({
        breaker,
        unstable,
        peer: 'peer-b',
        reason: 'channel-closed',
        attemptId: id,
        live,
        now,
      });
      now += 5_000;
    }
    const snap = breaker.snapshot('peer-b', now);
    expect(dials).toBeGreaterThan(2);
    expect(dials).toBeLessThanOrEqual(10);
    expect(snap.level).toBe(0);
    expect(snap.failures).toBe(0);
    expect(snap.disabled).toBe(false);
  });
});

describe('dc-stable-hold capability', () => {
  test('link.hello advertises the cap and a peer hello turns the hold on', async () => {
    const h = makeHarness();
    const [relay, relayPeer] = createInMemoryLinkPair();
    const seen: Array<{ t?: string; caps?: string[] }> = [];
    relayPeer.ctl.onMessage((bytes) => {
      seen.push(JSON.parse(new TextDecoder().decode(bytes)) as { t?: string; caps?: string[] });
    });
    h.registry.track(relay, PEER, 'relay', SELF, 0, false);
    await flush();
    expect(
      seen.some((msg) => msg.t === 'link.hello' && msg.caps?.includes(DC_STABLE_HOLD_CAP))
    ).toBe(true);
    const live = h.state.live.get(PEER);
    h.drain.handleLinkCtl(live!, 'link.hello', {
      t: 'link.hello',
      caps: ['quiesce', DC_STABLE_HOLD_CAP],
    });
    expect(peerSupportsDcStableHold(PEER)).toBe(true);

    const [dc] = createInMemoryLinkPair();
    h.registry.track(dc, PEER, 'dc', SELF, 0, false, null, 'dc:cap');
    const retiring = [...(h.state.retiring.get(PEER) ?? [])][0];
    retiring!.gotQuiesceAck = true;
    retiring!.gotPeerQuiesce = true;
    h.drain.maybeFinishRetire(retiring!);
    expect(retiring!.finishRetired).toBe(false);
  });

  test('without the cap, quiesce acks retire immediately and the death counts', async () => {
    const h = makeHarness();
    const link = installRelayThenDc(h, 'dc:old', false);
    const retiring = [...(h.state.retiring.get(PEER) ?? [])][0];
    retiring!.gotQuiesceAck = true;
    retiring!.gotPeerQuiesce = true;
    h.drain.maybeFinishRetire(retiring!);
    expect(retiring!.finishRetired).toBe(true);
    await flush();
    expect(link.relayReason()).toBe('replaced');
    link.dc.close('channel-closed');
    await flush();
    expect(h.failures).toEqual([{ kind: 'channel-closed', attempt: 'dc:old' }]);
    expect(h.unstableCalls).toEqual([]);
  });

  test('remote measure keeps a stable DC relay until the 30s cap', async () => {
    const h = makeHarness();
    const link = installRelayThenDc(h, 'dc:measure');
    markLiveDcProven(h.state.live.get(PEER)!);
    h.state.remoteMeasureUntil.set(PEER, Date.now() + 60_000);
    h.scheduler.advance(DC_MIN_STABLE_MS);
    await flush();
    expect(link.relayReason()).toBeUndefined();
    h.scheduler.advance(PEER_RETIRE_MAX_MS - DC_MIN_STABLE_MS);
    await flush();
    expect(link.relayReason()).toBe('replaced');
  });

  test('a beside relay dial does not replace the live DC', () => {
    const h = makeHarness();
    const [dc] = createInMemoryLinkPair();
    h.registry.track(dc, PEER, 'dc', SELF, 0, false, null, 'dc:live');
    const [relay] = createInMemoryLinkPair();
    h.registry.parkSide(PEER, relay);
    expect(h.state.live.get(PEER)?.session).toBe(dc);
    expect(h.state.sideRelays.get(PEER)).toBe(relay);
  });

  test('side relay dispatches inbound streams and answers one ping without becoming live', async () => {
    const h = makeHarness();
    const [dc] = createInMemoryLinkPair();
    h.registry.track(dc, PEER, 'dc', SELF, 0, false, null, 'dc:live');
    const [relay, remote] = createInMemoryLinkPair();
    h.registry.parkSide(PEER, relay);
    const pong = waitForCtl(remote, 'pong');
    remote.ctl.send(encodeCtlMessage({ t: 'ping', sentAt: 7 }));
    expect(await pong).toBe('pong');
    const stream = await remote.openStream(HTTP_OPEN);
    const info = await stream.closed;
    expect(info.reason).toBe('rst');
    expect(info.message).toBe('http-not-configured');
    expect(h.state.live.get(PEER)?.session).toBe(dc);
    expect(h.state.sideRelays.get(PEER)).toBe(relay);
  });

  test('DC death promotes the side relay to live instead of closing it', async () => {
    const h = makeHarness();
    const [dc] = createInMemoryLinkPair();
    h.registry.track(dc, PEER, 'dc', SELF, 0, false, null, 'dc:live');
    const [relay, remote] = createInMemoryLinkPair();
    let closed = false;
    void relay.closed.then(() => {
      closed = true;
    });
    h.registry.parkSide(PEER, relay);
    dc.close('channel-closed');
    await flush();
    expect(closed).toBe(false);
    expect(h.state.sideRelays.has(PEER)).toBe(false);
    expect(h.state.live.get(PEER)?.session).toBe(relay);
    expect(h.state.live.get(PEER)?.transport).toBe('relay');
    const pong = waitForCtl(remote, 'pong');
    remote.ctl.send(encodeCtlMessage({ t: 'ping', sentAt: 8 }));
    expect(await pong).toBe('pong');
    const stream = await remote.openStream(HTTP_OPEN);
    expect((await stream.closed).message).toBe('http-not-configured');
  });

  test('revoking the peer closes the side relay instead of promoting it', async () => {
    const h = makeHarness();
    const [dc] = createInMemoryLinkPair();
    h.registry.track(dc, PEER, 'dc', SELF, 0, false, null, 'dc:live');
    const [relay] = createInMemoryLinkPair();
    h.registry.parkSide(PEER, relay);
    h.registry.dropPeer(PEER, 'revoked');
    await flush();
    expect(h.state.sideRelays.has(PEER)).toBe(false);
    expect(h.state.live.get(PEER)?.session).not.toBe(relay);
    expect((await relay.closed).reason).toBe('revoked');
  });

  test('a DC that lives through the healthy window clears the next strike', async () => {
    const h = makeHarness();
    notePeerDcStableHold(PEER);
    const [first, firstPeer] = createInMemoryLinkPair();
    h.registry.track(first, PEER, 'dc', SELF, 0, false, null, 'dc:first');
    first.close('channel-closed');
    await flush();
    const [second, secondPeer] = createInMemoryLinkPair();
    answerPings(secondPeer);
    h.registry.track(second, PEER, 'dc', SELF, 0, false, null, 'dc:second');
    h.scheduler.advance(RTC_DIAL_BREAKER_HEALTHY_MS);
    await flush();
    second.close('channel-closed');
    await flush();
    const [third] = createInMemoryLinkPair();
    h.registry.track(third, PEER, 'dc', SELF, 0, false, null, 'dc:third');
    third.close('channel-closed');
    await flush();
    expect(h.unstableCalls.map((call) => call.cooldownMs)).toEqual([
      unstableCooldownMs(1),
      unstableCooldownMs(1),
    ]);
    void firstPeer;
  });
});

function answerPings(remote: LinkSession): void {
  remote.ctl.onMessage((bytes) => {
    let msg: { t?: string; sentAt?: number };
    try {
      msg = JSON.parse(new TextDecoder().decode(bytes)) as { t?: string; sentAt?: number };
    } catch {
      return;
    }
    if (msg.t !== 'ping') return;
    remote.ctl.send(encodeCtlMessage({ t: 'pong', sentAt: msg.sentAt }));
  });
}

function trackDc(
  h: ReturnType<typeof makeHarness>,
  attempt: string
): [LinkSession, LinkSession, LinkSession] {
  const [dc, dcPeer] = createInMemoryLinkPair();
  h.registry.track(dc, PEER, 'dc' as PeerTransportKind, SELF, 0, false, null, attempt);
  return [dc, dcPeer, dc];
}
