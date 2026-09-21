import { describe, expect, test } from 'bun:test';
import type { LinkSession } from '@vibeterm/shared/link';
import { RTT_EVENT_MIN_INTERVAL_MS } from './address-class';
import { notePeerPingTick, shouldEmitPeerRtt } from './peer-live-ping';
import type { LivePeer } from './peer-reconnect-wake';

function live(opts: {
  lastFrameAt?: number;
  lastInboundFrameAt?: number;
  missedPongs?: number;
  rttMs?: number | null;
  lastEmittedRttMs?: number | null;
  lastRttEmitAt?: number;
}): LivePeer {
  return {
    session: { lastFrameAt: opts.lastFrameAt } as LinkSession,
    lastInboundFrameAt: opts.lastInboundFrameAt ?? 0,
    missedPongs: opts.missedPongs ?? 0,
    rttMs: opts.rttMs ?? null,
    lastEmittedRttMs: opts.lastEmittedRttMs ?? null,
    lastRttEmitAt: opts.lastRttEmitAt ?? 0,
  } as LivePeer;
}

describe('notePeerPingTick', () => {
  test('LAN 档 3 次错过即判死；高 RTT 要更多次', () => {
    const lan = live({});
    expect(notePeerPingTick(lan, 40)).toBe('ping');
    expect(notePeerPingTick(lan, 40)).toBe('ping');
    expect(notePeerPingTick(lan, 40)).toBe('drop');
    expect(lan.missedPongs).toBe(3);

    const wan = live({});
    expect(notePeerPingTick(wan, 13_900)).toBe('ping');
    expect(notePeerPingTick(wan, 13_900)).toBe('ping');
    expect(notePeerPingTick(wan, 13_900)).toBe('ping');
    expect(wan.missedPongs).toBe(3);
    expect(notePeerPingTick(wan, 13_900)).toBe('ping');
    expect(notePeerPingTick(wan, 13_900)).toBe('drop');
    expect(wan.missedPongs).toBe(5);
  });

  test('新 inbound 帧清零 missed，不累加', () => {
    const row = live({ lastFrameAt: 80, lastInboundFrameAt: 10, missedPongs: 2 });
    expect(notePeerPingTick(row, 40)).toBe('ping');
    expect(row.missedPongs).toBe(0);
    expect(row.lastInboundFrameAt).toBe(80);
  });
});

describe('shouldEmitPeerRtt', () => {
  test('首次样本要发；未达最小间隔则压住', () => {
    const row = live({ rttMs: 40, lastEmittedRttMs: null });
    expect(shouldEmitPeerRtt(row, 1_000)).toBe(true);
    row.lastEmittedRttMs = 40;
    row.lastRttEmitAt = 1_000;
    row.rttMs = 80;
    expect(shouldEmitPeerRtt(row, 1_000 + RTT_EVENT_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(shouldEmitPeerRtt(row, 1_000 + RTT_EVENT_MIN_INTERVAL_MS)).toBe(true);
  });
});
