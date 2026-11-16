import { afterEach, describe, expect, test } from 'bun:test';
import { latestProbeForUrl, matchingTurnProbeRow, stunProbeRows } from './probe-views';
import { matchingTurnProbe } from './stun-effective';
import { stunProbeSnapshot } from './stun-probe';
import { resetTurnProbeForTest, setTurnProbeSnapshotForTest } from './turn-probe';

afterEach(() => {
  resetTurnProbeForTest();
});

describe('probe-views', () => {
  test('latestProbeForUrl 取同 URL 的最后一条', () => {
    const rows = [
      { url: 'turn:a', ok: false },
      { url: 'turn:b', ok: true },
      { url: 'turn:a', ok: true },
    ];
    expect(latestProbeForUrl('turn:a', rows)).toBe(rows[2] ?? null);
    expect(latestProbeForUrl('turn:c', rows)).toBeNull();
    expect(latestProbeForUrl(null, rows)).toBeNull();
  });

  test('探测栈加载后登记的视图与原快照一致', () => {
    setTurnProbeSnapshotForTest([
      { url: 'turn:relay.example.com:3478', ok: true, rttMs: 12, probedAt: 1 },
    ]);
    const configured = { url: 'turn:relay.example.com:3478', username: 'u', credential: 'c' };
    expect(matchingTurnProbeRow(configured)).toEqual(matchingTurnProbe(configured));
    expect(matchingTurnProbeRow(configured)?.ok).toBe(true);
    expect(matchingTurnProbeRow(null)).toBeNull();
    expect(stunProbeRows()).toEqual(stunProbeSnapshot());
  });
});
