import { describe, expect, test } from 'bun:test';
import { WatchRuleScheduler, effectiveIntervalSeconds } from './scheduler';

describe('effectiveIntervalSeconds', () => {
  test('llm 型 interval 下限 30s、其余 5s', () => {
    expect(effectiveIntervalSeconds({ triggerType: 'match', intervalSeconds: 1 })).toBe(5);
    expect(effectiveIntervalSeconds({ triggerType: 'match', intervalSeconds: 45 })).toBe(45);
    expect(effectiveIntervalSeconds({ triggerType: 'llm', intervalSeconds: 10 })).toBe(30);
  });
});

describe('WatchRuleScheduler', () => {
  test('add is idempotent and records the clamped interval', () => {
    const scheduler = new WatchRuleScheduler();
    const timers: Array<{ ms: number; cleared: boolean }> = [];
    const ticks: string[] = [];
    const scheduleInterval = (_fn: () => void, ms: number) => {
      const entry = { ms, cleared: false };
      timers.push(entry);
      return () => {
        entry.cleared = true;
      };
    };

    const first = scheduler.add(
      { id: 'r1', deviceId: 'd1', triggerType: 'match', intervalSeconds: 1 },
      (id) => ticks.push(id),
      scheduleInterval
    );
    const second = scheduler.add(
      { id: 'r1', deviceId: 'd1', triggerType: 'match', intervalSeconds: 1 },
      (id) => ticks.push(id),
      scheduleInterval
    );

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(scheduler.has('r1')).toBe(true);
    expect(timers).toEqual([{ ms: 5000, cleared: false }]);
  });

  test('detach clears the timer and waitForTick drains in-flight work', async () => {
    const scheduler = new WatchRuleScheduler();
    const gate: { open: (() => void) | null } = { open: null };
    const scheduleInterval = () => () => {};

    scheduler.add(
      { id: 'r1', deviceId: 'd1', triggerType: 'match', intervalSeconds: 30 },
      () => {},
      scheduleInterval
    );

    const running = scheduler.runExclusive('r1', async () => {
      await new Promise<void>((resolve) => {
        gate.open = resolve;
      });
    });
    const skipped = scheduler.runExclusive('r1', async () => {
      throw new Error('should not run concurrently');
    });
    await skipped;

    const detached = scheduler.detach('r1');
    expect(scheduler.has('r1')).toBe(false);
    expect(detached?.tickPromise).not.toBeNull();

    gate.open?.();
    await scheduler.waitForTick(detached as NonNullable<typeof detached>);
    await running;
    expect(detached?.tickPromise).toBeNull();
  });

  test('runExclusive on an unscheduled rule is a no-op', async () => {
    const scheduler = new WatchRuleScheduler();
    let ran = false;
    await scheduler.runExclusive('missing', async () => {
      ran = true;
    });
    expect(ran).toBe(false);
  });
});
