import { describe, expect, test } from 'bun:test';
import { generateEd25519KeyPair } from '@vibeterm/shared/auth';
import type { RtcSignalMessage } from './mesh-deps';
import {
  RTC_SIGNAL_INBOX_TTL_MS,
  type RtcSignalInboxEntry,
  RtcWakeGate,
  type RtcWakePorts,
  deliverRtcSignal,
  peerInitiatedRtcAttemptInput,
  shouldStartRtcAttempt,
} from './peer-rtc-wake';
import { encodeRtcWakeSdp, peerRtcSession } from './rtc/ice';

function setupReplay(entries: RtcSignalInboxEntry[]) {
  const peer = 'peer';
  const listeners = new Map<string, Set<(message: RtcSignalMessage) => void>>();
  const inbox = new Map([[peer, entries]]);
  const gate = new RtcWakeGate({
    scheduler: { now: () => 100_000 },
    rtcListeners: () => listeners,
    rtcInbox: () => inbox,
  } as unknown as RtcWakePorts);
  return { gate, inbox, listeners, peer };
}

describe('RtcWakeGate signaling inbox', () => {
  test('returns unsubscribe before replay and drops entries older than 30 seconds', async () => {
    const message = (to: string): RtcSignalMessage => ({
      rtcSession: 'dc:a:b',
      from: 'node',
      to,
      sdp: '{"type":"offer","sdp":"v=0"}',
    });
    const { gate, inbox, listeners, peer } = setupReplay([
      { message: message('expired'), receivedAt: 100_000 - RTC_SIGNAL_INBOX_TTL_MS - 1 },
      { message: message('fresh'), receivedAt: 100_000 - RTC_SIGNAL_INBOX_TTL_MS },
    ]);
    const seen: string[] = [];
    const unsubscribe = gate.signalingFor(peer).onMessage((signal) => seen.push(signal.to));

    expect(typeof unsubscribe).toBe('function');
    expect(listeners.get(peer)?.size).toBe(1);
    expect(inbox.has(peer)).toBe(false);
    await Promise.resolve();
    expect(seen).toEqual(['fresh']);
    unsubscribe();
    expect(listeners.has(peer)).toBe(false);
  });

  test('unsubscribing mid-replay restores the remaining inbox in order', async () => {
    const queued = ['first', 'second', 'third'].map((to) => ({
      message: {
        rtcSession: 'dc:a:b',
        from: 'node' as const,
        to,
        sdp: '{"type":"offer","sdp":"v=0"}',
      },
      receivedAt: 100_000,
    }));
    const { gate, inbox, peer } = setupReplay(queued);
    const seen: string[] = [];
    const unsubscribe = gate.signalingFor(peer).onMessage((signal) => {
      seen.push(signal.to);
      if (signal.to === 'second') unsubscribe();
    });
    await Promise.resolve();
    expect(seen).toEqual(['first', 'second']);
    expect((inbox.get(peer) ?? []).map((entry) => entry.message.to)).toEqual(['second', 'third']);
  });

  test('unsubscribe before the replay microtask prevents delivery', async () => {
    const queued: RtcSignalMessage = {
      rtcSession: 'dc:a:b',
      from: 'node',
      to: 'self',
      candidate: '{"candidate":"candidate:1","mid":"0"}',
    };
    const { gate, inbox, listeners, peer } = setupReplay([
      { message: queued, receivedAt: 100_000 },
    ]);
    let deliveries = 0;
    const unsubscribe = gate.signalingFor(peer).onMessage(() => {
      deliveries += 1;
    });
    unsubscribe();
    await Promise.resolve();
    expect(deliveries).toBe(0);
    expect(listeners.has(peer)).toBe(false);
    expect((inbox.get(peer) ?? []).map((entry) => entry.message)).toEqual([queued]);
  });
});

describe('shouldStartRtcAttempt', () => {
  const base = {
    allow: true,
    pending: false,
    upgrading: false,
    inflight: false,
    live: false,
    wantsUpgrade: false,
  };

  test('blocks a new attempt while a DC dial is in flight', () => {
    expect(shouldStartRtcAttempt(base)).toBe(true);
    expect(shouldStartRtcAttempt({ ...base, inflight: true })).toBe(false);
    expect(shouldStartRtcAttempt({ ...base, pending: true })).toBe(false);
    expect(shouldStartRtcAttempt({ ...base, live: true, wantsUpgrade: false })).toBe(false);
    expect(shouldStartRtcAttempt({ ...base, live: true, wantsUpgrade: true })).toBe(true);
  });

  test('peer-initiated input ignores a cooling self-dial and still wants DC', () => {
    expect(
      shouldStartRtcAttempt(
        peerInitiatedRtcAttemptInput({
          dcCapable: true,
          dcInflight: false,
          upgrading: false,
          live: undefined,
        })
      )
    ).toBe(true);
    expect(
      shouldStartRtcAttempt(
        peerInitiatedRtcAttemptInput({
          dcCapable: true,
          dcInflight: true,
          upgrading: false,
          live: undefined,
        })
      )
    ).toBe(false);
    expect(
      peerInitiatedRtcAttemptInput({
        dcCapable: true,
        dcInflight: false,
        upgrading: false,
        live: { transport: 'relay' },
      })
    ).toMatchObject({ allow: true, wantsUpgrade: true, pending: false });
    expect(
      peerInitiatedRtcAttemptInput({
        dcCapable: true,
        dcInflight: false,
        upgrading: false,
        live: { transport: 'dc' },
      }).wantsUpgrade
    ).toBe(false);
  });
});

describe('deliverRtcSignal', () => {
  test('returns false when the listener unsubscribes while handling a superseded offer', () => {
    const listeners = new Set<(message: RtcSignalMessage) => void>();
    const listener = () => {
      listeners.delete(listener);
    };
    listeners.add(listener);
    const delivered = deliverRtcSignal(listeners, {
      rtcSession: 'dc:a:b',
      from: 'node',
      to: 'peer',
      sdp: '{"type":"offer","sdp":"v=0","epoch":2}',
    });
    expect(delivered).toBe(false);
    expect(listeners.size).toBe(0);
  });
});

describe('RtcWakeGate peerInitiated flag', () => {
  test('incoming wake calls maybeUpgrade with peerInitiated even while cooling', () => {
    const self = 'aa'.repeat(16);
    const from = 'bb'.repeat(16);
    const upgrades: Array<{ nodeId: string; peerInitiated?: boolean }> = [];
    const ports = {
      identity: { nodeId: self, edSecretKey: new Uint8Array(64) },
      userStore: {},
      scheduler: {
        now: () => 1_000,
        sleep: async () => undefined,
        interval: () => ({ clear() {} }),
      },
      sendRtcSignal: () => undefined,
      dcCapable: () => true,
      maybeUpgrade: (nodeId: string, opts: { peerInitiated?: boolean }) => {
        upgrades.push({ nodeId, peerInitiated: opts.peerInitiated });
      },
      stopSignal: () => new AbortController().signal,
      stopped: () => false,
      isTrusted: () => true,
      live: () => new Map(),
      shouldTryDc: () => false,
      pending: () => new Map(),
      upgrading: () => new Map(),
      wantsUpgrade: () => false,
      getLink: async () => undefined,
      rtcListeners: () => new Map(),
      rtcInbox: () => new Map(),
      hasDcInflight: () => false,
      sendPeerCtl: () => undefined,
      ensureDcSession: null,
      uplinkSendCtl: () => undefined,
    } as unknown as RtcWakePorts;
    const gate = new RtcWakeGate(ports);
    gate.acceptSignedRtcWake = () => true;
    gate.handleIncomingRtcWake(from, {
      rtcSession: peerRtcSession(from, self),
      from: 'node',
      to: self,
      sdp: encodeRtcWakeSdp({
        from,
        to: self,
        rtcSession: peerRtcSession(from, self),
        issuedAt: 1_000,
        secretKey: generateEd25519KeyPair().secretKey,
      }),
    });
    expect(upgrades).toEqual([{ nodeId: from, peerInitiated: true }]);
  });
});
