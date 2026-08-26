import { describe, expect, jest, test } from 'bun:test';
import { RunWatchdog } from './run-watchdog';

interface Scheduled {
  handle: number;
  callback: () => void;
  delayMs: number;
}

function createFakeTimers() {
  const scheduled: Scheduled[] = [];
  const cancelled: number[] = [];
  let nextHandle = 1;
  return {
    scheduled,
    cancelled,
    timers: {
      setTimeout: (callback: () => void, delayMs: number) => {
        const handle = nextHandle;
        nextHandle += 1;
        scheduled.push({ handle, callback, delayMs });
        return handle;
      },
      clearTimeout: (handle: unknown) => {
        cancelled.push(handle as number);
        const index = scheduled.findIndex((item) => item.handle === handle);
        if (index >= 0) {
          scheduled.splice(index, 1);
        }
      },
    },
  };
}

describe('RunWatchdog', () => {
  test('start 排程超时，到期 onStall 只触发一次', () => {
    const { scheduled, timers } = createFakeTimers();
    let stalled = 0;
    const watchdog = new RunWatchdog({
      timeoutMs: 90_000,
      onStall: () => {
        stalled += 1;
      },
      timers,
    });
    watchdog.start();
    expect(scheduled).toEqual([{ handle: 1, callback: expect.any(Function), delayMs: 90_000 }]);
    scheduled[0]?.callback();
    expect(stalled).toBe(1);
    scheduled[0]?.callback();
    expect(stalled).toBe(1);
  });

  test('reset 取消旧定时器并重新计时', () => {
    const { scheduled, cancelled, timers } = createFakeTimers();
    let stalled = 0;
    const watchdog = new RunWatchdog({
      timeoutMs: 1000,
      onStall: () => {
        stalled += 1;
      },
      timers,
    });
    watchdog.start();
    watchdog.reset();
    expect(cancelled).toEqual([1]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.handle).toBe(2);
    expect(scheduled[0]?.delayMs).toBe(1000);
    expect(stalled).toBe(0);
  });

  test('clear 取消未触发的 stall', () => {
    const { scheduled, cancelled, timers } = createFakeTimers();
    let stalled = 0;
    const watchdog = new RunWatchdog({
      timeoutMs: 50,
      onStall: () => {
        stalled += 1;
      },
      timers,
    });
    watchdog.start();
    watchdog.clear();
    expect(cancelled).toEqual([1]);
    expect(scheduled).toHaveLength(0);
    expect(stalled).toBe(0);
  });

  test('fake timers：超时后 stall，reset 推迟触发', () => {
    jest.useFakeTimers();
    try {
      let stalled = 0;
      const watchdog = new RunWatchdog({
        timeoutMs: 90_000,
        onStall: () => {
          stalled += 1;
        },
      });
      watchdog.start();
      jest.advanceTimersByTime(89_999);
      expect(stalled).toBe(0);
      watchdog.reset();
      jest.advanceTimersByTime(89_999);
      expect(stalled).toBe(0);
      jest.advanceTimersByTime(1);
      expect(stalled).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
