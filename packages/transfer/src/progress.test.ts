import { describe, expect, test } from 'bun:test';
import { ProgressTracker, throttleProgress } from './progress';

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe('ProgressTracker', () => {
  test('rate is measured over the sliding window', () => {
    const c = clock();
    const tracker = new ProgressTracker({ totalBytes: 1000, now: c.now, windowMs: 2000 });
    c.advance(1000);
    tracker.set(100);
    expect(tracker.ratePerSec()).toBeCloseTo(100, 5);
    c.advance(1000);
    tracker.set(400);
    expect(tracker.ratePerSec()).toBeCloseTo(200, 5);
  });

  test('eta is null without a rate and 0 when finished', () => {
    const c = clock();
    const tracker = new ProgressTracker({ totalBytes: 500, now: c.now });
    expect(tracker.etaSec()).toBeNull();
    c.advance(1000);
    tracker.set(100);
    expect(tracker.etaSec()).toBeCloseTo(4, 5);
    tracker.set(500);
    expect(tracker.etaSec()).toBe(0);
  });

  test('unknown total yields a null eta', () => {
    const c = clock();
    const tracker = new ProgressTracker({ totalBytes: 0, now: c.now });
    c.advance(1000);
    tracker.add(1024);
    expect(tracker.snapshot().etaSec).toBeNull();
    expect(tracker.snapshot().transferredBytes).toBe(1024);
  });
});

describe('throttleProgress', () => {
  test('drops calls inside the interval and flushes the last value', () => {
    const c = clock();
    const seen: number[] = [];
    const emit = throttleProgress((n) => seen.push(n), { intervalMs: 200, now: c.now });
    emit(1);
    emit(2);
    emit(3);
    expect(seen).toEqual([1]);
    c.advance(200);
    emit(4);
    expect(seen).toEqual([1, 4]);
    emit(5);
    emit.flush();
    expect(seen).toEqual([1, 4, 5]);
  });

  test('a large byte jump bypasses the interval', () => {
    const c = clock();
    const seen: number[] = [];
    const emit = throttleProgress((n) => seen.push(n), {
      intervalMs: 10_000,
      minBytes: 100,
      now: c.now,
    });
    emit(10);
    emit(50);
    emit(200);
    expect(seen).toEqual([10, 200]);
  });
});
