import { describe, expect, test } from 'bun:test';
import type { LinkSession } from '@tmex/shared/link';
import {
  DcUpgradeCoordinator,
  type DcUpgradeLivePeer,
  type DcUpgradePorts,
} from './peer-dc-upgrade';
import { RTC_DIAL_FORCE_PROBE_MS } from './rtc/rtc-dial-breaker';
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

function makeCoordinator(opts: { scheduler?: MeshScheduler; recordDialFailure?: boolean } = {}) {
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
    probeQuiesce: () => {},
    hasWsSecureCandidate: () => true,
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
    expect(coordinator.dcUpgradeRetry.has(peer)).toBe(true);

    coordinator.onLocalFingerprintChanged();
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(false);

    disablePeer(coordinator, peer);
    coordinator.onPeerEndpointChanged(peer);
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(false);

    disablePeer(coordinator, peer);
    coordinator.onHubSwitched();
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(false);

    disablePeer(coordinator, peer);
    coordinator.onPeerReconnected(peer);
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

  test('probes every 10 minutes without external traffic and reschedules after failure', async () => {
    const scheduler = new ManualScheduler();
    const { coordinator, live, dials } = makeCoordinator({
      scheduler,
      recordDialFailure: true,
    });
    const peer = 'peer-probe';
    live.set(peer, livePeer(peer));
    disablePeer(coordinator, peer);

    coordinator.armDcUpgradeRetry(peer);
    expect(scheduler.sleeps).toEqual([RTC_DIAL_FORCE_PROBE_MS]);
    await scheduler.advance(RTC_DIAL_FORCE_PROBE_MS - 1);
    expect(dials).toEqual([]);
    await scheduler.advance(1);
    expect(dials).toEqual([peer]);
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(true);
    expect(scheduler.sleeps).toEqual([RTC_DIAL_FORCE_PROBE_MS, RTC_DIAL_FORCE_PROBE_MS]);

    await scheduler.advance(RTC_DIAL_FORCE_PROBE_MS - 1);
    expect(dials).toEqual([peer]);
    await scheduler.advance(1);
    expect(dials).toEqual([peer, peer]);
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
    unavailable.availability.dc = false;
    await unavailableScheduler.advance(RTC_DIAL_FORCE_PROBE_MS);
    expect(unavailable.dials).toEqual([]);
    expect(unavailable.coordinator.dcUpgradeRetry.size).toBe(0);
    expect(unavailable.lostDirect.has('unavailable')).toBe(false);
  });
});
