import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_DIAL_RTT_MS,
  adaptiveDeadlineMs,
  dialRttOrProxyMs,
  nestedDialBudgetsMs,
} from './adaptive-deadline';

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
    for (const rtt of [undefined, null, 0, 50, 300, 800, 2_000] as const) {
      const { connectMs, directMs, forwardMs, foregroundDcMs } = nestedDialBudgetsMs(rtt);
      expect(connectMs).toBeLessThan(directMs);
      expect(directMs).toBeLessThan(forwardMs);
      expect(foregroundDcMs).toBeGreaterThan(0);
      expect(foregroundDcMs).toBeLessThan(directMs);
    }
  });

  test('no-sample / non-positive RTT uses the 800 ms WAN proxy, not LAN 3/4/5 s', () => {
    expect(DEFAULT_DIAL_RTT_MS).toBe(800);
    expect(dialRttOrProxyMs(undefined)).toBe(800);
    expect(dialRttOrProxyMs(null)).toBe(800);
    expect(dialRttOrProxyMs(0)).toBe(800);
    expect(dialRttOrProxyMs(Number.NaN)).toBe(800);
    const none = nestedDialBudgetsMs(undefined);
    const zero = nestedDialBudgetsMs(0);
    const proxy = nestedDialBudgetsMs(DEFAULT_DIAL_RTT_MS);
    expect(none).toEqual(proxy);
    expect(zero).toEqual(proxy);
    expect(proxy.connectMs).toBe(4_800);
    expect(proxy.directMs).toBe(5_300);
    expect(proxy.forwardMs).toBe(6_900);
    expect(proxy.foregroundDcMs).toBe(2_400);
    expect(proxy.connectMs).toBeGreaterThan(3_000);
    expect(proxy.forwardMs).toBeGreaterThan(5_000);
  });

  test('LAN RTT still matches the historic 3s ⊂ 4s ⊂ 5s nest', () => {
    const { connectMs, directMs, forwardMs, foregroundDcMs } = nestedDialBudgetsMs(50);
    expect(connectMs).toBe(3_000);
    expect(directMs).toBe(4_000);
    expect(forwardMs).toBe(5_000);
    expect(foregroundDcMs).toBe(1_000);
  });

  test('800 ms RTT widens the nest so a cold dial fits under the forward deadline', () => {
    const { connectMs, directMs, forwardMs, foregroundDcMs } = nestedDialBudgetsMs(800);
    expect(connectMs).toBeGreaterThanOrEqual(4_800);
    expect(directMs).toBeGreaterThan(connectMs);
    expect(forwardMs).toBeGreaterThanOrEqual(directMs + 1_000);
    expect(forwardMs).toBeLessThanOrEqual(20_000);
    expect(foregroundDcMs).toBe(2_400);
  });

  test('custom connect 20 s at LAN RTT lifts direct/forward so connect < direct < forward', () => {
    const { connectMs, directMs, forwardMs } = nestedDialBudgetsMs(50, 20_000);
    expect(connectMs).toBe(20_000);
    expect(directMs).toBe(20_500);
    expect(forwardMs).toBeGreaterThan(directMs);
    expect(connectMs).toBeLessThan(directMs);
    expect(directMs).toBeLessThan(forwardMs);
  });

  test('short custom connect stays below adaptive direct', () => {
    const { connectMs, directMs, forwardMs } = nestedDialBudgetsMs(50, 20);
    expect(connectMs).toBe(20);
    expect(directMs).toBe(4_000);
    expect(forwardMs).toBe(5_000);
  });
});
