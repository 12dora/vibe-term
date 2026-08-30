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
      { id: 'r1', deviceId: 'd1', paneId: '%1', triggerType: 'match', intervalSeconds: 1 },
      (deviceId, paneId) => ticks.push(`${deviceId}:${paneId}`),
      scheduleInterval
    );
    const second = scheduler.add(
      { id: 'r1', deviceId: 'd1', paneId: '%1', triggerType: 'match', intervalSeconds: 1 },
      (deviceId, paneId) => ticks.push(`${deviceId}:${paneId}`),
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
      { id: 'r1', deviceId: 'd1', paneId: '%1', triggerType: 'match', intervalSeconds: 30 },
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

  test('同 pane 多规则共用一个 timer，间隔取最小值', () => {
    const scheduler = new WatchRuleScheduler();
    const timers: Array<{ ms: number; cleared: boolean; fire: () => void }> = [];
    const ticks: string[] = [];
    const scheduleInterval = (fn: () => void, ms: number) => {
      const entry = { ms, cleared: false, fire: fn };
      timers.push(entry);
      return () => {
        entry.cleared = true;
      };
    };

    scheduler.add(
      { id: 'r1', deviceId: 'd1', paneId: '%1', triggerType: 'match', intervalSeconds: 30 },
      (deviceId, paneId) => ticks.push(`${deviceId}:${paneId}`),
      scheduleInterval
    );
    scheduler.add(
      { id: 'r2', deviceId: 'd1', paneId: '%1', triggerType: 'match', intervalSeconds: 5 },
      (deviceId, paneId) => ticks.push(`${deviceId}:${paneId}`),
      scheduleInterval
    );
    scheduler.add(
      { id: 'r3', deviceId: 'd1', paneId: '%2', triggerType: 'match', intervalSeconds: 10 },
      (deviceId, paneId) => ticks.push(`${deviceId}:${paneId}`),
      scheduleInterval
    );

    const live = timers.filter((t) => !t.cleared);
    expect(live.map((t) => t.ms).sort((a, b) => a - b)).toEqual([5000, 10000]);

    live.find((t) => t.ms === 5000)?.fire();
    expect(ticks).toEqual(['d1:%1']);
  });

  test('100 条同 pane 规则只调度 1 个 timer；长 interval 规则跳过中间 tick', () => {
    const scheduler = new WatchRuleScheduler();
    const timers: Array<{ ms: number; fire: () => void }> = [];
    const scheduleInterval = (fn: () => void, ms: number) => {
      timers.push({ ms, fire: fn });
      return () => {};
    };

    for (let i = 0; i < 99; i++) {
      scheduler.add(
        {
          id: `fast-${i}`,
          deviceId: 'd1',
          paneId: '%1',
          triggerType: 'match',
          intervalSeconds: 5,
        },
        () => {},
        scheduleInterval
      );
    }
    scheduler.add(
      {
        id: 'slow',
        deviceId: 'd1',
        paneId: '%1',
        triggerType: 'llm',
        intervalSeconds: 30,
      },
      () => {},
      scheduleInterval
    );

    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(5000);

    expect(scheduler.takeDueRuleIds('d1', '%1')).toHaveLength(99);
    expect(scheduler.takeDueRuleIds('d1', '%1')).toHaveLength(99);
    expect(scheduler.takeDueRuleIds('d1', '%1')).toHaveLength(99);
    expect(scheduler.takeDueRuleIds('d1', '%1')).toHaveLength(99);
    expect(scheduler.takeDueRuleIds('d1', '%1')).toHaveLength(99);
    const sixth = scheduler.takeDueRuleIds('d1', '%1');
    expect(sixth).toHaveLength(100);
    expect(sixth).toContain('slow');
  });

  test('移除 pane 上最后一条规则才清 timer；更短规则移除后重臂到新的最小间隔', () => {
    const scheduler = new WatchRuleScheduler();
    const timers: Array<{ ms: number; cleared: boolean }> = [];
    const scheduleInterval = (_fn: () => void, ms: number) => {
      const entry = { ms, cleared: false };
      timers.push(entry);
      return () => {
        entry.cleared = true;
      };
    };

    scheduler.add(
      { id: 'slow', deviceId: 'd1', paneId: '%1', triggerType: 'match', intervalSeconds: 30 },
      () => {},
      scheduleInterval
    );
    scheduler.add(
      { id: 'fast', deviceId: 'd1', paneId: '%1', triggerType: 'match', intervalSeconds: 5 },
      () => {},
      scheduleInterval
    );
    scheduler.detach('fast');
    expect(timers.filter((t) => !t.cleared).map((t) => t.ms)).toEqual([30000]);

    scheduler.detach('slow');
    expect(timers.filter((t) => !t.cleared)).toHaveLength(0);
  });
});
