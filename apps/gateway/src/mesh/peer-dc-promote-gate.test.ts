import { describe, expect, test } from 'bun:test';
import { type LinkSession, createInMemoryLinkPair } from '@vibeterm/shared/link';
import {
  DC_PROMOTE_ADDITIVE_MS_DEFAULT,
  DC_PROMOTE_RATIO_DEFAULT,
  DcPromoteGate,
  dcPromoteTooSlow,
  mergeTrackIntercept,
} from './peer-dc-promote-gate';
import type { LivePeer } from './peer-reconnect-wake';
import type { TrackInterceptInput } from './route-degrade';
import { ImmediateScheduler } from './test-support';

const PEER = 'cd'.repeat(16);

function stubSession(): LinkSession {
  return createInMemoryLinkPair()[0];
}

function live(
  transport: LivePeer['transport'],
  session: LinkSession,
  rttMs: number | null
): LivePeer {
  return {
    peerNodeId: PEER,
    transport,
    session,
    rttMs,
    generation: 1,
  } as LivePeer;
}

function inputOf(
  transport: TrackInterceptInput['transport'],
  session: LinkSession,
  prev?: LivePeer
): TrackInterceptInput {
  return {
    session,
    peerNodeId: PEER,
    transport,
    initiatedBy: 'aa'.repeat(16),
    gen: 1,
    remoteAddress: null,
    dcAttemptId: 'dc:1',
    prev,
  };
}

function makeGate(opts: {
  now?: () => number;
  measureRtt?: (session: LinkSession, timeoutMs: number) => Promise<number | null>;
  backoffMs?: number;
  ratio?: number;
  additiveMs?: number;
}) {
  const scheduler = new ImmediateScheduler();
  const installed: LinkSession[] = [];
  const retired: LinkSession[] = [];
  const liveMap = new Map<string, LivePeer>();
  const gate = new DcPromoteGate({
    now: opts.now ?? (() => scheduler.now()),
    scheduler,
    forceInstall: (session, peerId, transport) => {
      installed.push(session);
      liveMap.set(peerId, live(transport, session, null));
      return session;
    },
    finishRetire: (row) => {
      retired.push(row.session);
    },
    liveOf: (id) => liveMap.get(id),
    measureRtt: opts.measureRtt,
    backoffMs: opts.backoffMs ?? 60_000,
    ratio: opts.ratio,
    additiveMs: opts.additiveMs,
  });
  return { gate, installed, retired, liveMap, scheduler };
}

describe('dcPromoteTooSlow', () => {
  test('2486 ms DC is slower than 89 ms ws-secure; 150 ms is not', () => {
    expect(dcPromoteTooSlow(2486, 89)).toBe(true);
    expect(dcPromoteTooSlow(150, 89)).toBe(false);
    expect(
      dcPromoteTooSlow(
        89 + DC_PROMOTE_ADDITIVE_MS_DEFAULT,
        89,
        DC_PROMOTE_RATIO_DEFAULT,
        DC_PROMOTE_ADDITIVE_MS_DEFAULT
      )
    ).toBe(false);
    expect(dcPromoteTooSlow(89 + DC_PROMOTE_ADDITIVE_MS_DEFAULT + 1, 89)).toBe(true);
  });

  test('threshold is configurable', () => {
    expect(dcPromoteTooSlow(120, 100, 1.1, 0)).toBe(true);
    expect(dcPromoteTooSlow(120, 100, 2, 50)).toBe(false);
  });
});

describe('DcPromoteGate', () => {
  test('no live continues so a slow DC can still be installed', () => {
    const { gate, installed } = makeGate({});
    const session = stubSession();
    expect(gate.decide(inputOf('dc', session)).action).toBe('continue');
    expect(installed).toEqual([]);
  });

  test('slow DC over ws-secure is measured then rejected, not installed', async () => {
    const current = stubSession();
    const dc = stubSession();
    const { gate, installed, liveMap } = makeGate({
      measureRtt: async () => 2486,
    });
    liveMap.set(PEER, live('ws-secure', current, 89));
    expect(gate.decide(inputOf('dc', dc, liveMap.get(PEER))).action).toBe('hold');
    await Bun.sleep(0);
    expect(installed).toEqual([]);
    expect((await dc.closed).reason).toBe('dc-promote-reject');
    expect(liveMap.get(PEER)?.session).toBe(current);
  });

  test('faster DC is installed as live with measured rtt', async () => {
    const current = stubSession();
    const dc = stubSession();
    const { gate, installed, liveMap, retired } = makeGate({
      measureRtt: async () => 40,
    });
    const prev = live('ws-secure', current, 89);
    liveMap.set(PEER, prev);
    expect(gate.decide(inputOf('dc', dc, prev)).action).toBe('hold');
    await Bun.sleep(0);
    expect(installed).toEqual([dc]);
    expect(liveMap.get(PEER)?.session).toBe(dc);
    expect(liveMap.get(PEER)?.rttMs).toBe(40);
    expect(retired).toEqual([current]);
  });

  test('backoff after reject blocks the next upgrade attempt', async () => {
    let now = 1_000;
    const current = stubSession();
    const first = stubSession();
    const second = stubSession();
    const { gate, liveMap } = makeGate({
      now: () => now,
      measureRtt: async () => 4000,
      backoffMs: 15_000,
    });
    liveMap.set(PEER, live('ws-secure', current, 80));
    gate.decide(inputOf('dc', first, liveMap.get(PEER)));
    await Bun.sleep(0);
    const again = gate.decide(inputOf('dc', second, liveMap.get(PEER)));
    expect(again).toEqual({ action: 'reject', reason: 'dc-promote-backoff' });
    now += 15_000;
    expect(gate.decide(inputOf('dc', stubSession(), liveMap.get(PEER))).action).toBe('hold');
  });

  test('recovering from relay to ws-secure arms backoff so DC is not promoted immediately', () => {
    const relay = stubSession();
    const ws = stubSession();
    const dc = stubSession();
    const { gate } = makeGate({ backoffMs: 60_000 });
    const prev = live('relay', relay, 212);
    expect(gate.decide(inputOf('ws-secure', ws, prev)).action).toBe('continue');
    expect(gate.decide(inputOf('dc', dc, live('ws-secure', ws, 89)))).toEqual({
      action: 'reject',
      reason: 'dc-promote-backoff',
    });
  });

  test('prev without rtt does not block install', () => {
    const { gate } = makeGate({});
    const prev = live('ws-secure', stubSession(), null);
    expect(gate.decide(inputOf('dc', stubSession(), prev)).action).toBe('continue');
  });
});

describe('mergeTrackIntercept', () => {
  test('route hold/reject wins; otherwise promote', () => {
    expect(mergeTrackIntercept({ action: 'hold' }, { action: 'reject', reason: 'x' }).action).toBe(
      'hold'
    );
    expect(mergeTrackIntercept({ action: 'continue' }, { action: 'hold' }).action).toBe('hold');
    expect(
      mergeTrackIntercept(undefined, { action: 'reject', reason: 'dc-promote-backoff' })
    ).toEqual({
      action: 'reject',
      reason: 'dc-promote-backoff',
    });
  });
});
