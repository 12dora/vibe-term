import { describe, expect, test } from 'bun:test';
import { SlidingWindowCounter } from './sliding-window';

describe('SlidingWindowCounter', () => {
  test('counts only hits inside the window', () => {
    let now = 1_000;
    const counter = new SlidingWindowCounter({ windowMs: 100, now: () => now });
    counter.hit('a');
    counter.hit('a');
    expect(counter.count('a')).toBe(2);
    expect(counter.count('b')).toBe(0);

    now += 100;
    expect(counter.count('a')).toBe(0);
    expect(counter.size).toBe(0);
  });

  test('hit returns the live count and keys stay independent', () => {
    const counter = new SlidingWindowCounter({ windowMs: 100, now: () => 1_000 });
    expect(counter.hit('a')).toBe(1);
    expect(counter.hit('a')).toBe(2);
    expect(counter.hit('b')).toBe(1);
    expect(counter.size).toBe(2);
  });

  test('release undoes the most recent hit and drops the key when empty', () => {
    const counter = new SlidingWindowCounter({ windowMs: 100, now: () => 1_000 });
    counter.hit('a');
    counter.hit('a');
    expect(counter.release('a')).toBe(true);
    expect(counter.count('a')).toBe(1);
    expect(counter.release('a')).toBe(true);
    expect(counter.size).toBe(0);
    expect(counter.release('a')).toBe(false);
  });

  test('reset and clear drop buckets', () => {
    const counter = new SlidingWindowCounter({ windowMs: 100, now: () => 1_000 });
    counter.hit('a');
    counter.hit('b');
    counter.reset('a');
    expect(counter.size).toBe(1);
    counter.clear();
    expect(counter.size).toBe(0);
  });

  test('sweep removes expired buckets without touching live ones', () => {
    let now = 1_000;
    const counter = new SlidingWindowCounter({ windowMs: 100, now: () => now });
    counter.hit('old');
    now += 60;
    counter.hit('fresh');
    now += 60;
    counter.sweep();
    expect(counter.size).toBe(1);
    expect(counter.count('fresh')).toBe(1);
  });

  test('expired-only eviction keeps live buckets even above maxKeys', () => {
    const counter = new SlidingWindowCounter({
      windowMs: 100,
      now: () => 1_000,
      maxKeys: 2,
      evict: 'expired-only',
    });
    for (const key of ['a', 'b', 'c', 'd']) counter.hit(key);
    expect(counter.size).toBe(4);
    expect(counter.count('a')).toBe(1);
  });

  test('oldest eviction drops the least recently started bucket first', () => {
    let now = 1_000;
    const counter = new SlidingWindowCounter({
      windowMs: 10_000,
      now: () => now,
      maxKeys: 2,
      evict: 'oldest',
    });
    counter.hit('a');
    now += 10;
    counter.hit('b');
    now += 10;
    counter.hit('c');
    expect(counter.size).toBe(2);
    expect(counter.count('a')).toBe(0);
    expect(counter.count('b')).toBe(1);
    expect(counter.count('c')).toBe(1);
  });

  test('oldest eviction breaks ties by insertion order', () => {
    const counter = new SlidingWindowCounter({
      windowMs: 10_000,
      now: () => 1_000,
      maxKeys: 2,
      evict: 'oldest',
    });
    counter.hit('a');
    counter.hit('b');
    counter.hit('c');
    expect(counter.count('a')).toBe(0);
    expect(counter.count('b')).toBe(1);
    expect(counter.count('c')).toBe(1);
  });

  test('expired buckets are reclaimed before any live bucket is evicted', () => {
    let now = 1_000;
    const counter = new SlidingWindowCounter({
      windowMs: 100,
      now: () => now,
      maxKeys: 2,
      evict: 'oldest',
    });
    counter.hit('stale-1');
    counter.hit('stale-2');
    now += 100;
    counter.hit('live-1');
    counter.hit('live-2');
    expect(counter.size).toBe(2);
    expect(counter.count('live-1')).toBe(1);
    expect(counter.count('live-2')).toBe(1);
  });

  test('explicit now overrides the clock', () => {
    const counter = new SlidingWindowCounter({ windowMs: 100, now: () => 1_000 });
    counter.hit('a', 500);
    expect(counter.count('a', 550)).toBe(1);
    expect(counter.count('a', 700)).toBe(0);
  });
});
