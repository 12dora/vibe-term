import { describe, expect, test } from 'bun:test';
import { type LinkSession, createInMemoryLinkPair } from '@vibeterm/shared/link';
import {
  applyExistingLive,
  bestRetiringPeer,
  consumeForcedSession,
  earlyTrackResult,
  existingLiveDecision,
  preparePromotedPeer,
} from './peer-live-rank';
import type { LivePeer } from './peer-reconnect-wake';

const SELF = 'aa'.repeat(16);
const PEER = 'bb'.repeat(16);

function stubSession(): LinkSession {
  return createInMemoryLinkPair()[0];
}

function live(partial: Partial<LivePeer> & Pick<LivePeer, 'transport' | 'session'>): LivePeer {
  return {
    peerNodeId: PEER,
    initiatedBy: SELF,
    generation: 1,
    streams: 0,
    lastStreamAt: 0,
    idleTimer: null,
    pingTimer: null,
    missedPongs: 0,
    lastInboundFrameAt: 0,
    retiring: false,
    retireReason: 'replaced',
    retiredAt: 0,
    zeroStreamsSince: 0,
    gotQuiesceAck: false,
    gotPeerQuiesce: false,
    retireTimer: null,
    finishRetired: false,
    lastAdvertisedStatusJson: '',
    unsubRtc: null,
    quiesceCapable: true,
    helloReplied: false,
    probeSent: false,
    remoteAddress: null,
    rttMs: 40,
    pingSentAt: 12,
    rttSpikeIgnored: true,
    lastRttEmitAt: 99,
    lastEmittedRttMs: 40,
    linkSinceAt: 0,
    dcAttemptId: null,
    rttSamples: 3,
    rttMinMs: 18,
    ...partial,
  };
}

describe('existingLiveDecision', () => {
  test('同 session 安装；更低优先级拒绝；无 quiesce 则 park', () => {
    const session = stubSession();
    expect(existingLiveDecision(undefined, session, 'dc', SELF, SELF).kind).toBe('install');
    const prev = live({ transport: 'dc', session, quiesceCapable: false });
    expect(existingLiveDecision(prev, session, 'dc', SELF, SELF).kind).toBe('install');
    expect(existingLiveDecision(prev, stubSession(), 'relay', SELF, SELF)).toEqual({
      kind: 'reject',
      reason: 'lower-priority',
    });
    expect(existingLiveDecision(prev, stubSession(), 'dc', SELF, SELF).kind).toBe('park');
    const quiesced = live({ transport: 'relay', session: stubSession(), quiesceCapable: true });
    expect(existingLiveDecision(quiesced, stubSession(), 'dc', SELF, SELF).kind).toBe('retire');
  });
});

describe('applyExistingLive / consumeForcedSession / earlyTrackResult', () => {
  test('park 回调后返回旧 session；retire 回调后继续', () => {
    const prev = live({ transport: 'relay', session: stubSession() });
    const parked: string[] = [];
    const retired: string[] = [];
    const park = applyExistingLive(
      { kind: 'park' },
      prev,
      () => parked.push('park'),
      () => retired.push('retire')
    );
    expect(park).toEqual({ parked: prev.session });
    expect(parked).toEqual(['park']);
    const next = applyExistingLive(
      { kind: 'retire' },
      prev,
      () => parked.push('park'),
      () => retired.push('retire')
    );
    expect(next).toEqual({ next: true });
    expect(retired).toEqual(['retire']);
    expect(
      applyExistingLive(
        { kind: 'reject', reason: 'x' },
        prev,
        () => {},
        () => {}
      )
    ).toEqual({
      reject: 'x',
    });
  });

  test('forceInstall 只消费一次', () => {
    const bypass = new WeakSet<LinkSession>();
    const session = stubSession();
    expect(consumeForcedSession(bypass, session)).toBe(false);
    bypass.add(session);
    expect(consumeForcedSession(bypass, session)).toBe(true);
    expect(consumeForcedSession(bypass, session)).toBe(false);
  });

  test('earlyTrackResult：continue 放行，reject 关流', () => {
    const prev = live({ transport: 'relay', session: stubSession() });
    const closed: string[] = [];
    expect(earlyTrackResult({ action: 'continue' }, prev, (r) => closed.push(r))).toBeNull();
    expect(
      earlyTrackResult({ action: 'reject', reason: 'dc-promote-backoff' }, prev, (r) =>
        closed.push(r)
      )
    ).toEqual({ result: prev.session });
    expect(closed).toEqual(['dc-promote-backoff']);
  });
});

describe('bestRetiringPeer / preparePromotedPeer', () => {
  test('跳过 excluded 与 finishRetired，选更高传输', () => {
    const excluded = live({ transport: 'dc', session: stubSession() });
    const done = live({ transport: 'dc', session: stubSession(), finishRetired: true });
    const relay = live({ transport: 'relay', session: stubSession() });
    const ws = live({ transport: 'ws-secure', session: stubSession() });
    expect(bestRetiringPeer([excluded, done, relay, ws], excluded)).toBe(ws);
    expect(bestRetiringPeer([done], null)).toBeNull();
  });

  test('promote 清 RTT 样本并解除 retiring', () => {
    let cleared = 0;
    const row = live({
      transport: 'ws-secure',
      session: stubSession(),
      retiring: true,
      retireReason: 'idle',
      retiredAt: 9,
      retireTimer: {
        clear: () => {
          cleared += 1;
        },
      },
      gotQuiesceAck: true,
      gotPeerQuiesce: true,
    });
    preparePromotedPeer(row);
    expect(cleared).toBe(1);
    expect(row.retiring).toBe(false);
    expect(row.retireReason).toBe('replaced');
    expect(row.retiredAt).toBe(0);
    expect(row.retireTimer).toBeNull();
    expect(row.gotQuiesceAck).toBe(false);
    expect(row.gotPeerQuiesce).toBe(false);
    expect(row.rttMs).toBeNull();
    expect(row.pingSentAt).toBeNull();
    expect(row.rttSpikeIgnored).toBe(false);
    expect(row.rttSamples).toBe(0);
    expect(row.rttMinMs).toBeUndefined();
    expect(row.lastEmittedRttMs).toBeNull();
    expect(row.lastRttEmitAt).toBe(0);
  });
});
