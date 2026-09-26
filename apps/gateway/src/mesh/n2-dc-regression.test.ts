import { expect, test } from 'bun:test';
import { generateEd25519KeyPair } from '@vibeterm/shared/auth';
import type { UserStore } from '../auth/user-store';
import {
  DcUpgradeCoordinator,
  type DcUpgradeLivePeer,
  type DcUpgradePorts,
} from './peer-dc-upgrade';
import { runDirectDialRace } from './peer-dial-race';
import { evaluateCanDialDirect } from './peer-direct-dial-policy';
import { RtcWakeGate } from './peer-rtc-wake';
import type { PeerConnectionLike } from './rtc/native';
import { RtcDialBreaker } from './rtc/rtc-dial-breaker';
import { createIceCandidateTrace } from './rtc/rtc-log';
import { encodeDcOfferDecline } from './rtc/rtc-offer-decline';
import { createRtcSignalApplier, createSignalingAttemptState } from './rtc/rtc-signal-apply';
import type { MeshIdentity, PeerTransportKind } from './types';

const PEER = '11'.repeat(16);
const SELF = 'ff'.repeat(16);

test('gated wake still sends while the breaker is cooling', () => {
  const wakes: string[] = [];
  const pair = generateEd25519KeyPair();
  const identity = { nodeId: SELF, edSecretKey: pair.secretKey } as MeshIdentity;
  const gate = new RtcWakeGate({
    identity,
    userStore: {} as UserStore,
    scheduler: {
      now: () => 1,
      sleep: () => new Promise(() => {}),
      interval: () => ({ clear() {} }),
    },
    sendRtcSignal: () => {},
    dcCapable: () => true,
    maybeUpgrade: () => {},
    stopSignal: () => new AbortController().signal,
    stopped: () => false,
    isTrusted: () => true,
    live: () => new Map(),
    shouldTryDc: () => false,
    pending: () => new Map(),
    upgrading: () => new Map(),
    wantsUpgrade: () => false,
    getLink: async () => null,
    rtcListeners: () => new Map(),
    rtcInbox: () => new Map(),
    hasDcInflight: () => false,
    sendPeerCtl: () => {},
    uplinkSendCtl: () => wakes.push(PEER),
  });
  gate.dispatchRtcWake(PEER);
  expect(wakes).toEqual([]);
  gate.dispatchRtcWake(PEER, { gated: true });
  expect(wakes).toEqual([PEER]);
  gate.dispose();
});

test('a live proven DC resets the breaker even after a foreign attempt failed', () => {
  let now = 0;
  const breaker = new RtcDialBreaker({ now: () => now, breakerMs: 30_000, healthyMs: 60_000 });
  breaker.noteFailure(PEER, 'timeout', 'seed');
  breaker.noteChannelEstablished(PEER, 'live');
  const seeded = breaker.snapshot(PEER).failures;
  expect(seeded).toBeGreaterThan(0);
  now = 30_000;
  breaker.noteFailure(PEER, 'timeout', 'other');
  expect(breaker.snapshot(PEER).failures).toBe(seeded);
  now = 60_000;
  expect(breaker.noteHealthy(PEER, now, { ageMs: 60_000, proven: true })).toBe(true);
  expect(breaker.snapshot(PEER).failures).toBe(0);
  for (let i = 0; i < 10; i += 1) breaker.noteFailure(PEER, 'timeout', `f${i}`);
  expect(breaker.isDisabled(PEER)).toBe(false);
});

test('uplink switch decays escalation instead of wiping it', () => {
  const live = new Map<string, DcUpgradeLivePeer>();
  const ports: DcUpgradePorts = {
    scheduler: {
      now: () => 0,
      sleep: () => new Promise(() => {}),
      interval: () => ({ clear() {} }),
    },
    live: () => live,
    dialDc: async () => {
      throw new Error('no dial');
    },
    shouldTryDc: () => false,
    dcCapable: () => true,
    emitLinkInfo: () => {},
    log: () => {},
    stopped: () => false,
    stopSignal: () => new AbortController().signal,
    isTrusted: () => true,
    pending: () => new Map(),
    upgrading: () => new Map(),
    hasDcInflight: () => false,
    probeQuiesce: () => {},
    hasWsSecureCandidate: () => false,
    lostDirect: () => new Set(),
  };
  const coordinator = new DcUpgradeCoordinator(ports);
  for (const id of ['aa', 'bb']) {
    live.set(id, liveOf(id));
    for (let i = 0; i < 10; i += 1) {
      coordinator.dcBreaker.beginAttempt(id, `f${i}`);
      coordinator.dcBreaker.noteFailure(id, 'timeout', `f${i}`);
    }
    expect(coordinator.dcBreaker.isDisabled(id)).toBe(true);
  }
  const before = coordinator.dcBreaker.snapshot('aa').failures;
  coordinator.onUplinkSwitched();
  expect(coordinator.dcBreaker.isDisabled('aa')).toBe(false);
  expect(coordinator.dcBreaker.snapshot('aa').failures).toBe(before);
  expect(coordinator.dcBreaker.snapshot('bb').failures).toBeGreaterThan(0);
  coordinator.dispose();
});

test('a decline whose epoch does not match is dropped', () => {
  const state = createSignalingAttemptState(4);
  const declined: number[] = [];
  state.onDeclined = () => declined.push(1);
  const apply = createRtcSignalApplier(
    { setRemoteDescription: async () => {} } as unknown as PeerConnectionLike,
    PEER,
    'answer',
    state,
    createIceCandidateTrace()
  );
  apply({
    rtcSession: 's',
    from: 'node',
    to: PEER,
    sdp: encodeDcOfferDecline('cooling', { epoch: 1, retryAfterMs: 30_000 }),
  });
  expect(declined).toEqual([]);
  apply({
    rtcSession: 's',
    from: 'node',
    to: PEER,
    sdp: encodeDcOfferDecline('cooling', { retryAfterMs: 30_000 }),
  });
  expect(declined).toEqual([1]);
});

test('a DC leg that already applied remote SDP is not aborted when ws wins', async () => {
  let aborted = false;
  const session = { close() {} };
  const outcome = await runDirectDialRace({
    dc: (signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve(null);
        });
      }),
    ws: async () => session,
    wsFirst: true,
    budgetMs: 10_000,
    deadlineMs: 60_000,
    signal: new AbortController().signal,
    now: () => 0,
    sleep: () => new Promise(() => {}),
    discard: () => {},
    dcSdpApplied: () => true,
  });
  expect(outcome.winner).toBe('ws');
  expect(aborted).toBe(false);
});

test('peer-initiated and trust failures do not open the breaker', () => {
  const breaker = new RtcDialBreaker({ now: () => 0, disableAfter: 3 });
  for (let i = 0; i < 6; i += 1) {
    breaker.noteFailure(PEER, 'timeout', `p${i}`, undefined, { peerInitiated: true });
  }
  expect(breaker.isDisabled(PEER)).toBe(false);
  expect(breaker.snapshot(PEER).failures).toBe(0);
  breaker.noteRemoteRefusal(PEER, 30_000);
  expect(breaker.isDisabled(PEER)).toBe(false);
});

test('canDialDirect is false while paused, cooling, or the route refuses', () => {
  expect(
    evaluateCanDialDirect({
      paused: true,
      allowsUpgrade: true,
      breakerAllows: true,
      permanentHold: false,
      upgradeCooling: false,
      peerInitiated: false,
    })
  ).toBe(false);
  expect(
    evaluateCanDialDirect({
      paused: false,
      allowsUpgrade: false,
      breakerAllows: true,
      permanentHold: false,
      upgradeCooling: false,
      peerInitiated: false,
    })
  ).toBe(false);
  expect(
    evaluateCanDialDirect({
      paused: false,
      allowsUpgrade: true,
      breakerAllows: false,
      permanentHold: false,
      upgradeCooling: false,
      peerInitiated: false,
    })
  ).toBe(false);
  expect(
    evaluateCanDialDirect({
      paused: false,
      allowsUpgrade: true,
      breakerAllows: false,
      permanentHold: false,
      upgradeCooling: true,
      peerInitiated: true,
    })
  ).toBe(true);
});

function liveOf(nodeId: string, transport: PeerTransportKind = 'relay'): DcUpgradeLivePeer {
  return {
    retiring: false,
    transport,
    peerNodeId: nodeId,
    quiesceCapable: true,
    session: { close() {} } as DcUpgradeLivePeer['session'],
    dcAttemptId: null,
  };
}
