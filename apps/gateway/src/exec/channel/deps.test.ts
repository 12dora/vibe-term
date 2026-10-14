import { describe, expect, test } from 'bun:test';
import { MAX_TIMER_MS, type TimerApi, createClock, realClock } from './deps';

type Pending = { fn: () => void; ms: number; cancelled: boolean };

function fakeTimers() {
  const all: Pending[] = [];
  const api: TimerApi = {
    setTimeout: (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      all.push(entry);
      return entry;
    },
    clearTimeout: (handle) => {
      (handle as Pending).cancelled = true;
    },
  };
  const fireNext = () => {
    const entry = all.find((e) => !e.cancelled);
    if (!entry) throw new Error('no live timer');
    entry.cancelled = true;
    entry.fn();
  };
  return { all, api, fireNext };
}

describe('createClock', () => {
  test('short delays map to a single timer', () => {
    const t = fakeTimers();
    let fired = 0;
    createClock(t.api, () => 0).setTimeout(() => fired++, 1000);
    expect(t.all.map((e) => e.ms)).toEqual([1000]);
    t.fireNext();
    expect(fired).toBe(1);
  });

  test('delays above 2^31-1 ms re-arm in capped steps and fire once at the end', () => {
    const t = fakeTimers();
    let fired = 0;
    const total = MAX_TIMER_MS * 2 + 5000;
    createClock(t.api, () => 0).setTimeout(() => fired++, total);
    t.fireNext();
    t.fireNext();
    expect(fired).toBe(0);
    t.fireNext();
    expect(fired).toBe(1);
    expect(t.all.map((e) => e.ms)).toEqual([MAX_TIMER_MS, MAX_TIMER_MS, 5000]);
  });

  test('an exact multiple of the cap does not add an empty step', () => {
    const t = fakeTimers();
    let fired = 0;
    createClock(t.api, () => 0).setTimeout(() => fired++, MAX_TIMER_MS * 2);
    t.fireNext();
    t.fireNext();
    expect(fired).toBe(1);
    expect(t.all).toHaveLength(2);
  });

  test('clearTimeout cancels the currently armed step', () => {
    const t = fakeTimers();
    let fired = 0;
    const clock = createClock(t.api, () => 0);
    const handle = clock.setTimeout(() => fired++, MAX_TIMER_MS + 10);
    t.fireNext();
    clock.clearTimeout(handle);
    expect(() => t.fireNext()).toThrow('no live timer');
    expect(fired).toBe(0);
  });
});

describe('realClock', () => {
  test('a 30-day timer neither fires immediately nor blocks clearing', async () => {
    let fired = false;
    const handle = realClock.setTimeout(
      () => {
        fired = true;
      },
      30 * 24 * 3600 * 1000
    );
    await Bun.sleep(30);
    expect(fired).toBe(false);
    realClock.clearTimeout(handle);
  });

  test('short timers still fire', async () => {
    const done = new Promise<void>((resolve) => realClock.setTimeout(resolve, 5));
    await done;
  });
});
