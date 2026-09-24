import { describe, expect, test } from 'bun:test';
import type { LinkSession } from '@vibeterm/shared/link';
import {
  DcUpgradeCoordinator,
  type DcUpgradeLivePeer,
  type DcUpgradePorts,
} from './peer-dc-upgrade';
import { PERMANENT_FAILURE_HOLD_MS, isBackgroundDcUpgradeBlocked } from './peer-dc-upgrade-gate';
import { DC_PRESENCE_ABSENCE_MS, type LivePeer, PeerReconnectWake } from './peer-reconnect-wake';
import { RTC_DIAL_BREAKER_FAILS, RTC_DIAL_FORCE_PROBE_MS } from './rtc/rtc-dial-breaker';
import type { MeshScheduler, PeerTransportKind } from './types';

class ManualScheduler implements MeshScheduler {
  nowMs = 1_000;
  readonly sleeps: number[] = [];
  private sleepers: Array<{
    at: number;
    resolve: () => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort: () => void;
  }> = [];

  now(): number {
    return this.nowMs;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(ms);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        return;
      }
      const sleeper = {
        at: this.nowMs + ms,
        resolve: () => {
          signal?.removeEventListener('abort', sleeper.onAbort);
          resolve();
        },
        reject: (error: Error) => {
          signal?.removeEventListener('abort', sleeper.onAbort);
          reject(error);
        },
        signal,
        onAbort: () => {
          this.sleepers = this.sleepers.filter((row) => row !== sleeper);
          sleeper.reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
        },
      };
      this.sleepers.push(sleeper);
      signal?.addEventListener('abort', sleeper.onAbort, { once: true });
    });
  }

  interval(): { clear: () => void } {
    return { clear() {} };
  }

  async advance(ms: number): Promise<void> {
    this.nowMs += ms;
    const due = this.sleepers.filter((row) => row.at <= this.nowMs);
    this.sleepers = this.sleepers.filter((row) => row.at > this.nowMs);
    for (const sleeper of due) sleeper.resolve();
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
}

function fakeSession(): LinkSession {
  return { close() {} } as unknown as LinkSession;
}

function livePeer(nodeId: string, transport: PeerTransportKind = 'ws-secure'): DcUpgradeLivePeer {
  return {
    retiring: false,
    transport,
    peerNodeId: nodeId,
    quiesceCapable: true,
    session: fakeSession(),
    dcAttemptId: null,
  };
}

function makeCoordinator(
  opts: {
    scheduler?: MeshScheduler;
    recordDialFailure?: boolean;
    dcInflight?: () => boolean;
    hasWsSecure?: () => boolean;
  } = {}
) {
  const scheduler = opts.scheduler ?? new ManualScheduler();
  const live = new Map<string, DcUpgradeLivePeer>();
  const pending = new Map<string, Promise<LinkSession>>();
  const upgrading = new Map<string, Promise<LinkSession>>();
  const lostDirect = new Set<string>();
  const stop = new AbortController();
  const dials: string[] = [];
  const availability = { dc: true };
  const ports: DcUpgradePorts = {
    scheduler,
    live: () => live,
    dialDc: async (nodeId) => {
      dials.push(nodeId);
      if (opts.recordDialFailure) {
        const attemptId = `dial-${dials.length}`;
        coordinator.dcBreaker.beginAttempt(nodeId, attemptId);
        coordinator.dcBreaker.noteFailure(nodeId, 'timeout', attemptId);
      }
      throw new Error('dc-fail');
    },
    shouldTryDc: (nodeId) => coordinator.dcBreaker.shouldTry(nodeId).allow,
    dcCapable: () => availability.dc,
    emitLinkInfo: () => {},
    log: () => {},
    stopped: () => stop.signal.aborted,
    stopSignal: () => stop.signal,
    isTrusted: () => true,
    pending: () => pending,
    upgrading: () => upgrading,
    hasDcInflight: opts.dcInflight ?? (() => false),
    probeQuiesce: () => {},
    hasWsSecureCandidate: opts.hasWsSecure ?? (() => true),
    lostDirect: () => lostDirect,
  };
  const coordinator = new DcUpgradeCoordinator(ports);
  return { coordinator, live, dials, lostDirect, stop, availability };
}

function disablePeer(coordinator: DcUpgradeCoordinator, peer: string): void {
  for (let i = 0; i < 10; i += 1) {
    coordinator.dcBreaker.noteFailure(peer, 'timeout', `f${i}-${peer}-${Math.random()}`);
  }
}

describe('DcUpgradeCoordinator disabled DC upgrade', () => {
  test('wake sources re-arm disabled peers while an automatic probe is scheduled', () => {
    const { coordinator, live, dials } = makeCoordinator();
    const peer = 'peer-a';
    live.set(peer, livePeer(peer));
    disablePeer(coordinator, peer);
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(true);
    coordinator.armDcUpgradeRetry(peer);
    expect(dials).toEqual([]);
    expect(coordinator.dcUpgradeRetry.has(peer)).toBe(false);

    coordinator.onLocalFingerprintChanged();
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(false);

    disablePeer(coordinator, peer);
    coordinator.onPeerEndpointChanged(peer);
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(false);

    disablePeer(coordinator, peer);
    coordinator.onUplinkSwitched();
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(false);

    disablePeer(coordinator, peer);
    coordinator.onPeerReconnected(peer);
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(true);
    coordinator.onPeerCapabilitiesChanged(peer);
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(false);

    disablePeer(coordinator, peer);
    coordinator.retryDcUpgrade(peer);
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(false);
    coordinator.dispose();
  });

  test('disabled state does not drop a live ws-secure peer', () => {
    const { coordinator, live } = makeCoordinator();
    const peer = 'peer-b';
    const session = fakeSession();
    live.set(peer, { ...livePeer(peer), session });
    disablePeer(coordinator, peer);
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(true);
    expect(live.get(peer)?.transport).toBe('ws-secure');
    expect(live.get(peer)?.session).toBe(session);
    expect(coordinator.wantsUpgrade(live.get(peer)!)).toBe(false);
    coordinator.dispose();
  });

  test('disabled breaker does not dial until rearm', async () => {
    const scheduler = new ManualScheduler();
    const { coordinator, live, dials } = makeCoordinator({
      scheduler,
      recordDialFailure: true,
    });
    const peer = 'peer-probe';
    live.set(peer, livePeer(peer));
    disablePeer(coordinator, peer);

    coordinator.armDcUpgradeRetry(peer);
    coordinator.maybeUpgrade(peer, { cooldown: false });
    expect(dials).toEqual([]);
    expect(coordinator.dcUpgradeRetry.has(peer)).toBe(false);
    await scheduler.advance(RTC_DIAL_FORCE_PROBE_MS);
    expect(dials).toEqual([]);

    coordinator.onPeerReconnected(peer);
    await flushMicrotasks();
    expect(dials).toEqual([]);
    coordinator.onPeerEndpointChanged(peer);
    await flushMicrotasks();
    expect(dials).toEqual([peer]);
    coordinator.dispose();
  });

  test('scan skips peers whose last DC failure is permanent', async () => {
    const { coordinator, live, dials } = makeCoordinator();
    const peer = 'peer-nosrflx';
    live.set(peer, livePeer(peer, 'relay'));
    coordinator.dcBreaker.noteFailure(peer, 'no srflx candidates', 'a1');
    expect(coordinator.wantsUpgrade(live.get(peer)!)).toBe(false);
    coordinator.maybeUpgrade(peer, { cooldown: false });
    await flushMicrotasks();
    expect(dials).toEqual([]);
    coordinator.dispose();
  });

  test('permanent failure hold expires after 60 min then one probe; a fresh failure re-arms', async () => {
    const scheduler = new ManualScheduler();
    const { coordinator, live, dials } = makeCoordinator({ scheduler });
    const peer = 'peer-hold';
    live.set(peer, livePeer(peer, 'relay'));
    coordinator.dcBreaker.noteFailure(peer, 'no srflx candidates', 'h1');
    coordinator.maybeUpgrade(peer, { cooldown: false });
    await flushMicrotasks();
    expect(dials).toEqual([]);

    await scheduler.advance(PERMANENT_FAILURE_HOLD_MS - 1);
    coordinator.maybeUpgrade(peer, { cooldown: false });
    await flushMicrotasks();
    expect(dials).toEqual([]);

    await scheduler.advance(1);
    coordinator.maybeUpgrade(peer, { cooldown: false });
    await flushMicrotasks();
    expect(dials).toEqual([peer]);

    coordinator.maybeUpgrade(peer, { cooldown: false });
    await flushMicrotasks();
    expect(dials).toEqual([peer]);

    coordinator.dcBreaker.noteFailure(peer, 'no srflx candidates', 'h2');
    coordinator.maybeUpgrade(peer, { cooldown: false });
    await flushMicrotasks();
    expect(dials).toEqual([peer]);

    await scheduler.advance(PERMANENT_FAILURE_HOLD_MS);
    coordinator.maybeUpgrade(peer, { cooldown: false });
    await flushMicrotasks();
    expect(dials).toEqual([peer, peer]);
    coordinator.dispose();
  });

  test('released probe 建 DC 后立刻清 hold，不等 noteHealthy；新永久失败再武装', async () => {
    const scheduler = new ManualScheduler();
    const { coordinator, live, dials } = makeCoordinator({ scheduler });
    const peer = 'peer-established';
    live.set(peer, livePeer(peer, 'relay'));
    coordinator.dcBreaker.noteFailure(peer, 'no srflx candidates', 'e1');
    coordinator.maybeUpgrade(peer, { cooldown: false });
    await flushMicrotasks();
    expect(dials).toEqual([]);
    await scheduler.advance(PERMANENT_FAILURE_HOLD_MS);
    coordinator.maybeUpgrade(peer, { cooldown: false });
    await flushMicrotasks();
    expect(dials).toEqual([peer]);
    expect(isBackgroundDcUpgradeBlocked(coordinator.dcBreaker, peer, scheduler.now())).toBe(true);

    coordinator.dcBreaker.noteChannelEstablished(peer, 'ok');
    expect(isBackgroundDcUpgradeBlocked(coordinator.dcBreaker, peer, scheduler.now())).toBe(false);
    coordinator.maybeUpgrade(peer, { cooldown: false });
    await flushMicrotasks();
    expect(dials).toEqual([peer, peer]);

    coordinator.dcBreaker.noteFailure(peer, 'no srflx candidates', 'e2');
    expect(isBackgroundDcUpgradeBlocked(coordinator.dcBreaker, peer, scheduler.now())).toBe(true);
    coordinator.maybeUpgrade(peer, { cooldown: false });
    await flushMicrotasks();
    expect(dials).toEqual([peer, peer]);
    coordinator.dispose();
  });

  test('breaker disabled stays blocked after the permanent-failure hold until rearm', async () => {
    const scheduler = new ManualScheduler();
    const { coordinator, live, dials } = makeCoordinator({ scheduler });
    const peer = 'peer-disabled-hold';
    live.set(peer, livePeer(peer));
    disablePeer(coordinator, peer);
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(true);
    coordinator.maybeUpgrade(peer, { cooldown: false });
    await scheduler.advance(PERMANENT_FAILURE_HOLD_MS);
    coordinator.maybeUpgrade(peer, { cooldown: false });
    await flushMicrotasks();
    expect(dials).toEqual([]);
    coordinator.onPeerReconnected(peer);
    await flushMicrotasks();
    expect(dials).toEqual([]);
    coordinator.onPeerCapabilitiesChanged(peer);
    await flushMicrotasks();
    expect(dials).toEqual([peer]);
    coordinator.dispose();
  });

  test('cancels a scheduled disabled probe when stopped, live is lost, or DC is unavailable', async () => {
    const stoppedScheduler = new ManualScheduler();
    const stopped = makeCoordinator({ scheduler: stoppedScheduler });
    stopped.live.set('stopped', livePeer('stopped'));
    disablePeer(stopped.coordinator, 'stopped');
    stopped.coordinator.armDcUpgradeRetry('stopped');
    stopped.stop.abort(new Error('stopped'));
    stopped.coordinator.dispose();
    await stoppedScheduler.advance(RTC_DIAL_FORCE_PROBE_MS);
    expect(stopped.dials).toEqual([]);
    expect(stopped.coordinator.dcUpgradeRetry.size).toBe(0);

    const missingScheduler = new ManualScheduler();
    const missing = makeCoordinator({ scheduler: missingScheduler });
    missing.live.set('missing', livePeer('missing'));
    disablePeer(missing.coordinator, 'missing');
    missing.coordinator.armDcUpgradeRetry('missing');
    missing.live.delete('missing');
    await missingScheduler.advance(RTC_DIAL_FORCE_PROBE_MS);
    expect(missing.dials).toEqual([]);
    expect(missing.coordinator.dcUpgradeRetry.size).toBe(0);

    const unavailableScheduler = new ManualScheduler();
    const unavailable = makeCoordinator({ scheduler: unavailableScheduler });
    unavailable.live.set('unavailable', livePeer('unavailable'));
    unavailable.lostDirect.add('unavailable');
    disablePeer(unavailable.coordinator, 'unavailable');
    unavailable.coordinator.armDcUpgradeRetry('unavailable');
    expect(unavailable.coordinator.dcUpgradeRetry.size).toBe(0);
    unavailable.availability.dc = false;
    await unavailableScheduler.advance(RTC_DIAL_FORCE_PROBE_MS);
    expect(unavailable.dials).toEqual([]);
    expect(unavailable.lostDirect.has('unavailable')).toBe(true);
  });
});

describe('DcUpgradeCoordinator relay flap vs presence return', () => {
  test('a relay session flap does not rearm or reset escalation', () => {
    const scheduler = new ManualScheduler();
    const { coordinator, live } = makeCoordinator({ scheduler });
    const peer = 'ec42f364';
    live.set(peer, livePeer(peer, 'relay'));
    climbDisabled(coordinator, scheduler, peer);
    const before = coordinator.dcBreaker.snapshot(peer);
    expect(before.disabled).toBe(true);
    expect(before.level).toBe(5);

    const wake = new PeerReconnectWake();
    const woken: string[] = [];
    wake.lost(peer, true, false);
    const session = {
      peerNodeId: peer,
      transport: 'relay',
      quiesceCapable: false,
    } as LivePeer;
    wake.installed(session, (id) => woken.push(id));
    expect(woken).toEqual([]);
    session.quiesceCapable = true;
    wake.ready(session, (id) => {
      woken.push(id);
      coordinator.onPeerReconnected(id);
    });
    expect(woken).toEqual([peer]);
    scheduler.nowMs += 60 * 60 * 1000;
    coordinator.onPeerReconnected(peer);
    expect(coordinator.dcBreaker.snapshot(peer)).toMatchObject({
      disabled: true,
      level: before.level,
      failures: before.failures,
    });
    coordinator.dispose();
  });

  test('presence return after a long absence probes once and keeps escalation', async () => {
    const scheduler = new ManualScheduler();
    const { coordinator, live, dials } = makeCoordinator({ scheduler });
    const peer = 'ec42f364';
    live.set(peer, livePeer(peer, 'relay'));
    climbDisabled(coordinator, scheduler, peer);
    const before = coordinator.dcBreaker.snapshot(peer);
    expect(before.level).toBeGreaterThan(1);

    coordinator.noteRelayPresence(peer, false);
    scheduler.nowMs += DC_PRESENCE_ABSENCE_MS - 1;
    expect(coordinator.noteRelayPresence(peer, true)).toBe(false);
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(true);
    expect(coordinator.dcBreaker.snapshot(peer).level).toBe(before.level);
    expect(dials).toEqual([]);

    coordinator.noteRelayPresence(peer, false);
    scheduler.nowMs += DC_PRESENCE_ABSENCE_MS;
    expect(coordinator.noteRelayPresence(peer, true)).toBe(true);
    expect(coordinator.dcBreaker.snapshot(peer)).toMatchObject({
      disabled: false,
      level: before.level - 1,
      failures: before.failures,
    });
    expect(coordinator.dcBreaker.snapshot(peer).level).toBeGreaterThan(0);
    await flushMicrotasks();
    expect(dials).toEqual([peer]);

    coordinator.dcBreaker.noteFailure(peer, 'timeout', 'probe-fail');
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(true);
    coordinator.dispose();
  });
});

function climbDisabled(
  coordinator: DcUpgradeCoordinator,
  scheduler: ManualScheduler,
  peer: string
): void {
  for (let round = 0; round < 5; round += 1) {
    const until = coordinator.dcBreaker.snapshot(peer).until;
    if (until != null && until > scheduler.now()) scheduler.nowMs = until;
    for (let i = 0; i < RTC_DIAL_BREAKER_FAILS; i += 1) {
      coordinator.dcBreaker.noteFailure(peer, 'timeout', `c${round}-${i}`);
    }
  }
}

describe('DcUpgradeCoordinator ws-secure vs DC inflight', () => {
  test('dc inflight does not suppress a ws-secure upgrade on live relay', async () => {
    const { coordinator, live, dials } = makeCoordinator({ dcInflight: () => true });
    const peer = 'peer-ws';
    live.set(peer, livePeer(peer, 'relay'));
    coordinator.maybeUpgrade(peer, { cooldown: false });
    await flushMicrotasks();
    expect(dials).toEqual([peer]);
    coordinator.dispose();
  });

  test('dc inflight still coalesces a dc-only upgrade', async () => {
    const { coordinator, live, dials } = makeCoordinator({
      dcInflight: () => true,
      hasWsSecure: () => false,
    });
    const peer = 'peer-dc';
    live.set(peer, livePeer(peer, 'ws-secure'));
    coordinator.maybeUpgrade(peer, { cooldown: false });
    await flushMicrotasks();
    expect(dials).toEqual([]);
    coordinator.dispose();
  });
});

describe('DcUpgradeCoordinator.willAttemptUpgrade', () => {
  test('熔断健康且无排队升级时不算 pending', () => {
    const { coordinator, live } = makeCoordinator();
    const peer = 'peer-idle';
    live.set(peer, livePeer(peer, 'ws-secure'));
    expect(coordinator.wantsUpgrade(live.get(peer)!)).toBe(true);
    expect(coordinator.willAttemptUpgrade(peer)).toBe(false);
    coordinator.dispose();
  });

  test('coalesced / scheduled 且未冷却、非 lost-direct 时为 true', () => {
    const { coordinator, live } = makeCoordinator({ dcInflight: () => true });
    const peer = 'peer-queued';
    live.set(peer, livePeer(peer, 'ws-secure'));
    coordinator.maybeUpgrade(peer, { cooldown: false });
    expect(coordinator.upgradeGate.get(peer)?.coalesced).toBe(true);
    expect(coordinator.willAttemptUpgrade(peer)).toBe(true);
    coordinator.dispose();
  });

  test('只是在等 quiesce 探测回包时不算即将拨号', () => {
    const { coordinator, live } = makeCoordinator();
    const peer = 'peer-quiesce';
    live.set(peer, { ...livePeer(peer, 'ws-secure'), quiesceCapable: false });
    coordinator.maybeUpgrade(peer, { cooldown: false });
    expect(coordinator.upgradeGate.get(peer)?.coalesced).toBe(true);
    expect(coordinator.willAttemptUpgrade(peer)).toBe(false);
    coordinator.dispose();
  });

  test('冷却中或 lost-direct 退避时不算即将拨号', () => {
    const scheduler = new ManualScheduler();
    const cooling = makeCoordinator({ scheduler, dcInflight: () => true });
    const peer = 'peer-hold';
    cooling.live.set(peer, livePeer(peer, 'ws-secure'));
    cooling.coordinator.maybeUpgrade(peer, { cooldown: false });
    cooling.coordinator.ensureGate(peer).nextEligibleAt = scheduler.nowMs + 10_000;
    expect(cooling.coordinator.willAttemptUpgrade(peer)).toBe(false);

    const lost = makeCoordinator({ scheduler });
    lost.live.set(peer, livePeer(peer, 'ws-secure'));
    lost.coordinator.ensureGate(peer).coalesced = true;
    lost.lostDirect.add(peer);
    expect(lost.coordinator.willAttemptUpgrade(peer)).toBe(false);
    cooling.coordinator.dispose();
    lost.coordinator.dispose();
  });
});
