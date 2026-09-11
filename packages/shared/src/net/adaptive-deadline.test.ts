import { describe, expect, test } from 'bun:test';
import { adaptiveDeadlineMs, nestedDialBudgetsMs } from './adaptive-deadline';

describe('adaptiveDeadlineMs', () => {
  test('clamps latency × factor into [min, max]', () => {
    expect(adaptiveDeadlineMs({ rttMs: 100, factor: 8, minMs: 15_000, maxMs: 60_000 })).toBe(
      15_000
    );
    expect(adaptiveDeadlineMs({ rttMs: 3_000, factor: 8, minMs: 15_000, maxMs: 60_000 })).toBe(
      24_000
    );
    expect(adaptiveDeadlineMs({ rttMs: 10_000, factor: 8, minMs: 15_000, maxMs: 60_000 })).toBe(
      60_000
    );
  });

  test('null / undefined / non-positive RTT fall back to min', () => {
    const opts = { factor: 6, minMs: 3_000, maxMs: 15_000 };
    expect(adaptiveDeadlineMs({ ...opts, rttMs: null })).toBe(3_000);
    expect(adaptiveDeadlineMs({ ...opts, rttMs: undefined })).toBe(3_000);
    expect(adaptiveDeadlineMs({ ...opts, rttMs: 0 })).toBe(3_000);
    expect(adaptiveDeadlineMs({ ...opts, rttMs: -5 })).toBe(3_000);
    expect(adaptiveDeadlineMs({ ...opts, rttMs: Number.NaN })).toBe(3_000);
  });
});

describe('nestedDialBudgetsMs', () => {
  test('connect < direct < forward for representative RTTs', () => {
    for (const rtt of [0, 300, 800, 2_000]) {
      const { connectMs, directMs, forwardMs } = nestedDialBudgetsMs(rtt);
      expect(connectMs).toBeLessThan(directMs);
      expect(directMs).toBeLessThan(forwardMs);
    }
  });

  test('LAN-ish default matches the historic 3s ⊂ 4s ⊂ 5s nest', () => {
    const { connectMs, directMs, forwardMs } = nestedDialBudgetsMs(0);
    expect(connectMs).toBe(3_000);
    expect(directMs).toBe(4_000);
    expect(forwardMs).toBe(5_000);
  });

  test('800 ms RTT widens the nest so a cold dial fits under the forward deadline', () => {
    const { connectMs, directMs, forwardMs } = nestedDialBudgetsMs(800);
    expect(connectMs).toBeGreaterThanOrEqual(4_800);
    expect(directMs).toBeGreaterThan(connectMs);
    expect(forwardMs).toBeGreaterThanOrEqual(directMs + 1_000);
    expect(forwardMs).toBeLessThanOrEqual(20_000);
  });
});
