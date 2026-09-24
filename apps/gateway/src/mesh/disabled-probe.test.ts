import { expect, test } from 'bun:test';
import type { LinkSession } from '@vibeterm/shared/link';
import {
  DcUpgradeCoordinator,
  type DcUpgradeLivePeer,
  type DcUpgradePorts,
} from './peer-dc-upgrade';
import type { RtcDialBreaker } from './rtc/rtc-dial-breaker';
import type { MeshScheduler, PeerTransportKind } from './types';

class ManualScheduler implements MeshScheduler {
  nowMs = 1_000_000;
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
    for (let i = 0; i < 32; i += 1) await Promise.resolve();
  }
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

type ProbeHooks = {
  onDial: (breaker: RtcDialBreaker) => 'decline' | 'recover';
};

function makeSide(scheduler: ManualScheduler, peerId: string, hooks: ProbeHooks) {
  const live = new Map<string, DcUpgradeLivePeer>();
  const pending = new Map<string, Promise<LinkSession>>();
  const upgrading = new Map<string, Promise<LinkSession>>();
  const stop = new AbortController();
  let probes = 0;
  const ports: DcUpgradePorts = {
    scheduler,
    live: () => live,
    dialDc: async () => {
      probes += 1;
      const breaker = coordinator.dcBreaker;
      const id = `p${probes}`;
      breaker.beginAttempt(peerId, id);
      if (hooks.onDial(breaker) === 'decline') throw new Error('dc-declined');
      return fakeSession();
    },
    shouldTryDc: (nodeId) => coordinator.dcBreaker.shouldTry(nodeId).allow,
    dcCapable: () => true,
    emitLinkInfo: () => {},
    log: () => {},
    stopped: () => stop.signal.aborted,
    stopSignal: () => stop.signal,
    isTrusted: () => true,
    pending: () => pending,
    upgrading: () => upgrading,
    hasDcInflight: () => false,
    probeQuiesce: () => {},
    hasWsSecureCandidate: () => true,
    lostDirect: () => new Set(),
  };
  const coordinator = new DcUpgradeCoordinator(ports);
  live.set(peerId, livePeer(peerId));
  return {
    coordinator,
    live,
    probes: () => probes,
    dispose: () => coordinator.dispose(),
  };
}

function disable(coordinator: DcUpgradeCoordinator, peer: string): void {
  for (let i = 0; i < 10; i += 1) {
    const id = `f${i}-${peer}`;
    coordinator.dcBreaker.beginAttempt(peer, id);
    coordinator.dcBreaker.noteFailure(peer, 'timeout', id);
  }
}

async function drive(scheduler: ManualScheduler, recovered: () => boolean): Promise<number | null> {
  const start = scheduler.now();
  for (let i = 0; i < 80 && !recovered(); i += 1) await scheduler.advance(30_000);
  return recovered() ? scheduler.now() - start : null;
}

test('mutually disabled peers with different probe phases meet through the scheduler', async () => {
  const offsets = [0, 10, 20, 60, 180, 300];
  for (const offsetSec of offsets) {
    const elapsed = await runMutual(offsetSec);
    expect(elapsed).not.toBeNull();
    expect(elapsed ?? 0).toBeLessThanOrEqual(40 * 60 * 1000);
  }
});

async function runMutual(offsetSec: number): Promise<number | null> {
  const scheduler = new ManualScheduler();
  let recovered = false;
  const offer = makeSide(scheduler, 'bb', {
    onDial: (breaker) =>
      react(breaker, 'bb', wake.coordinator.dcBreaker, 'aa', () => {
        recovered = true;
      }),
  });
  const wake = makeSide(scheduler, 'aa', {
    onDial: (breaker) =>
      react(breaker, 'aa', offer.coordinator.dcBreaker, 'bb', () => {
        recovered = true;
      }),
  });
  disable(offer.coordinator, 'bb');
  if (offsetSec > 0) await scheduler.advance(offsetSec * 1000);
  disable(wake.coordinator, 'aa');
  const elapsed = await drive(scheduler, () => recovered);
  expect(offer.probes() + wake.probes()).toBeLessThan(12);
  offer.dispose();
  wake.dispose();
  return elapsed;
}

function react(
  self: RtcDialBreaker,
  selfPeer: string,
  other: RtcDialBreaker,
  otherPeer: string,
  mark: () => void
): 'decline' | 'recover' {
  const block = other.inboundBlock(otherPeer);
  if (block) {
    const cool = other.refusalCooldown(otherPeer);
    self.noteRemoteRefusal(selfPeer, cool.until);
    return 'decline';
  }
  other.noteInboundAccepted(otherPeer);
  mark();
  return 'recover';
}

test('disabled offerer declines a level-5 wake instead of letting it time out', async () => {
  const scheduler = new ManualScheduler();
  let recovered = false;
  const offer = makeSide(scheduler, 'bb', {
    onDial: (breaker) =>
      react(breaker, 'bb', wake.coordinator.dcBreaker, 'aa', () => {
        recovered = true;
      }),
  });
  const wake = makeSide(scheduler, 'aa', {
    onDial: (breaker) =>
      react(breaker, 'aa', offer.coordinator.dcBreaker, 'bb', () => {
        recovered = true;
      }),
  });
  await coolToAnswerRefuse(wake.coordinator, scheduler, 'aa');
  const failures = wake.coordinator.dcBreaker.snapshot('aa').failures;
  expect(wake.coordinator.dcBreaker.isDisabled('aa')).toBe(false);
  expect(wake.coordinator.dcBreaker.snapshot('aa').level).toBeGreaterThanOrEqual(5);
  wake.coordinator.armDcUpgradeRetry('aa');
  disable(offer.coordinator, 'bb');
  const elapsed = await drive(scheduler, () => recovered);
  expect(elapsed).not.toBeNull();
  expect(elapsed ?? 0).toBeLessThanOrEqual(40 * 60 * 1000);
  expect(wake.coordinator.dcBreaker.snapshot('aa').failures).toBe(failures);
  offer.dispose();
  wake.dispose();
});

async function coolToAnswerRefuse(
  coordinator: DcUpgradeCoordinator,
  scheduler: ManualScheduler,
  peer: string
): Promise<void> {
  let n = 0;
  while (coordinator.dcBreaker.snapshot(peer).level < 5 && n < 40) {
    const until = coordinator.dcBreaker.snapshot(peer).until;
    if (until != null && until > scheduler.now())
      await scheduler.advance(until - scheduler.now() + 1);
    const id = `c${n}`;
    n += 1;
    coordinator.dcBreaker.beginAttempt(peer, id);
    coordinator.dcBreaker.noteFailure(peer, 'timeout', id);
  }
}

test('a hopeless disabled peer is probed at 10 then 20 minutes, not every scan', async () => {
  const scheduler = new ManualScheduler();
  const times: number[] = [];
  const side = makeSide(scheduler, 'ec42', {
    onDial: (breaker) => {
      times.push(scheduler.now());
      breaker.noteFailure('ec42', 'timeout', `t${times.length}`);
      return 'decline';
    },
  });
  disable(side.coordinator, 'ec42');
  const start = scheduler.now();
  for (let i = 0; i < 360; i += 1) await scheduler.advance(30_000);
  side.dispose();
  expect(times.length).toBeGreaterThanOrEqual(2);
  expect(times.length).toBeLessThanOrEqual(6);
  expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(20 * 60 * 1000 - 60_000);
  expect((times[0] ?? 0) - start).toBeGreaterThanOrEqual(10 * 60 * 1000);
  expect((times[0] ?? 0) - start).toBeLessThanOrEqual(10 * 60 * 1000 + 60_000);
});
