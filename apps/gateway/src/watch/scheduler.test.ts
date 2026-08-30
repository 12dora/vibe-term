import { describe, expect, spyOn, test } from 'bun:test';
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
    const clock = { now: 0 };
    const scheduler = new WatchRuleScheduler({ now: () => clock.now });
    const timers: Array<{ ms: number; cleared: boolean }> = [];
    const scheduleInterval = (_fn: () => void, ms: number) => {
      const entry = { ms, cleared: false };
      timers.push(entry);
      return () => {
        entry.cleared = true;
      };
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

    expect(timers.filter((t) => !t.cleared)).toHaveLength(1);
    expect(timers.filter((t) => !t.cleared)[0]?.ms).toBe(5000);

    for (const at of [5000, 10_000, 15_000, 20_000, 25_000]) {
      clock.now = at;
      expect(scheduler.takeDueRuleIds('d1', '%1')).toHaveLength(99);
    }
    clock.now = 30_000;
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

  test('detach 最后一条规则时若 pane tick 在飞，随后 attach 必须重新武装 timer', async () => {
    const clock = { now: 0 };
    const scheduler = new WatchRuleScheduler({ now: () => clock.now });
    const timers: Array<{ ms: number; cleared: boolean }> = [];
    const scheduleInterval = (_fn: () => void, ms: number) => {
      const entry = { ms, cleared: false };
      timers.push(entry);
      return () => {
        entry.cleared = true;
      };
    };
    const add = (id: string, intervalSeconds: number) =>
      scheduler.add(
        { id, deviceId: 'd1', paneId: '%1', triggerType: 'match', intervalSeconds },
        () => {},
        scheduleInterval
      );

    add('r1', 5);
    expect(timers.filter((t) => !t.cleared)).toHaveLength(1);

    let release: () => void = () => {};
    const inflight = scheduler.runPaneExclusive('d1', '%1', async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    scheduler.detach('r1');
    expect(scheduler.has('r1')).toBe(false);
    expect(timers.filter((t) => !t.cleared)).toHaveLength(0);

    add('r2', 30);
    const live = timers.filter((t) => !t.cleared);
    expect(live).toHaveLength(1);
    expect(live[0]?.ms).toBe(30_000);

    release();
    await inflight;
    expect(timers.filter((t) => !t.cleared)).toHaveLength(1);
  });

  test('5s + 7s 规则按各自绝对 deadline 触发，7s 规则在 7/14/21 而非 10/20', () => {
    const clock = { now: 0 };
    const scheduler = new WatchRuleScheduler({ now: () => clock.now });
    const timers: Array<{ ms: number; cleared: boolean }> = [];
    const scheduleInterval = (_fn: () => void, ms: number) => {
      const entry = { ms, cleared: false };
      timers.push(entry);
      return () => {
        entry.cleared = true;
      };
    };
    const add = (id: string, intervalSeconds: number) =>
      scheduler.add(
        { id, deviceId: 'd1', paneId: '%1', triggerType: 'match', intervalSeconds },
        () => {},
        scheduleInterval
      );

    add('r5', 5);
    add('r7', 7);
    expect(timers.filter((t) => !t.cleared).map((t) => t.ms)).toEqual([5000]);

    const fired: Record<string, number[]> = { r5: [], r7: [] };
    const tickAt = (ms: number) => {
      clock.now = ms;
      for (const id of scheduler.takeDueRuleIds('d1', '%1')) {
        fired[id]?.push(ms);
      }
    };

    tickAt(5000);
    expect(timers.filter((t) => !t.cleared).map((t) => t.ms)).toEqual([2000]);
    tickAt(7000);
    expect(timers.filter((t) => !t.cleared).map((t) => t.ms)).toEqual([3000]);
    tickAt(10_000);
    tickAt(14_000);
    tickAt(15_000);
    tickAt(20_000);
    tickAt(21_000);

    expect(fired.r5).toEqual([5000, 10_000, 15_000, 20_000]);
    expect(fired.r7).toEqual([7000, 14_000, 21_000]);
  });

  test('移除已等待 25s 的 5s 规则不推迟同组 30s 规则的 deadline', () => {
    const clock = { now: 0 };
    const scheduler = new WatchRuleScheduler({ now: () => clock.now });
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

    clock.now = 25_000;
    scheduler.detach('fast');
    expect(timers.filter((t) => !t.cleared).map((t) => t.ms)).toEqual([5000]);

    clock.now = 30_000;
    expect(scheduler.takeDueRuleIds('d1', '%1')).toEqual(['slow']);
  });

  test('pane tick 进行中到达的 timer 记为 pending，完成后补跑，5s 规则不会被 30s 慢评估饿死', async () => {
    const clock = { now: 0 };
    const scheduler = new WatchRuleScheduler({ now: () => clock.now });
    const scheduleInterval = () => () => {};
    const add = (id: string, intervalSeconds: number, triggerType: 'match' | 'llm' = 'match') =>
      scheduler.add(
        { id, deviceId: 'd1', paneId: '%1', triggerType, intervalSeconds },
        () => {},
        scheduleInterval
      );

    add('fast', 5);
    add('slow', 30, 'llm');

    const dueLog: Array<{ now: number; due: string[] }> = [];
    let release: () => void = () => {};
    const fn = async () => {
      const due = scheduler.takeDueRuleIds('d1', '%1');
      dueLog.push({ now: clock.now, due: [...due] });
      if (due.includes('slow')) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    };

    clock.now = 30_000;
    const inflight = scheduler.runPaneExclusive('d1', '%1', fn);
    await Promise.resolve();
    expect(dueLog).toHaveLength(1);
    expect(dueLog[0]?.due).toEqual(expect.arrayContaining(['fast', 'slow']));

    clock.now = 35_000;
    const coalesced = scheduler.runPaneExclusive('d1', '%1', fn);
    await Promise.resolve();
    expect(dueLog).toHaveLength(1);

    release();
    await inflight;
    await coalesced;
    expect(dueLog).toHaveLength(2);
    expect(dueLog[1]).toEqual({ now: 35_000, due: ['fast'] });
  });

  test('Date.now rollback between add and first callback does not re-arm a full interval', () => {
    const dateNow = spyOn(Date, 'now');
    let wall = 1_700_000_000_000;
    dateNow.mockImplementation(() => wall);
    try {
      const delays: number[] = [];
      const scheduler = new WatchRuleScheduler();
      const scheduleInterval = (_fn: () => void, ms: number) => {
        delays.push(ms);
        return () => {};
      };

      scheduler.add(
        { id: 'r1', deviceId: 'd1', paneId: '%1', triggerType: 'match', intervalSeconds: 5 },
        () => {},
        scheduleInterval
      );
      expect(delays[0]).toBeGreaterThan(4900);
      expect(delays[0]).toBeLessThanOrEqual(5000);

      wall -= 3_600_000;
      expect(scheduler.takeDueRuleIds('d1', '%1')).toEqual([]);
      expect(delays.at(-1)).toBeLessThanOrEqual(5000);
    } finally {
      dateNow.mockRestore();
    }
  });

  test('Date.now restoration (forward leap) does not create a huge delay', () => {
    const dateNow = spyOn(Date, 'now');
    let wall = 1_700_000_000_000;
    dateNow.mockImplementation(() => wall);
    try {
      const delays: number[] = [];
      const scheduler = new WatchRuleScheduler();
      const scheduleInterval = (_fn: () => void, ms: number) => {
        delays.push(ms);
        return () => {};
      };

      scheduler.add(
        { id: 'r1', deviceId: 'd1', paneId: '%1', triggerType: 'match', intervalSeconds: 5 },
        () => {},
        scheduleInterval
      );

      wall += 3_600_000;
      expect(scheduler.takeDueRuleIds('d1', '%1')).toEqual([]);
      expect(delays.at(-1)).toBeLessThanOrEqual(5000);
      expect(delays.at(-1)).toBeGreaterThan(4900);
    } finally {
      dateNow.mockRestore();
    }
  });

  test('monotonic elapsed time is preserved when wall clock rolls back', () => {
    const mono = { now: 0 };
    const scheduler = new WatchRuleScheduler({ now: () => mono.now });
    const delays: number[] = [];
    const scheduleInterval = (_fn: () => void, ms: number) => {
      delays.push(ms);
      return () => {};
    };

    scheduler.add(
      { id: 'r1', deviceId: 'd1', paneId: '%1', triggerType: 'match', intervalSeconds: 5 },
      () => {},
      scheduleInterval
    );
    expect(delays).toEqual([5000]);

    mono.now = 4000;
    expect(scheduler.takeDueRuleIds('d1', '%1')).toEqual([]);
    expect(delays.at(-1)).toBe(1000);
  });

  test('default clock uses performance.now rather than Date.now', () => {
    const perf = spyOn(performance, 'now');
    const dateNow = spyOn(Date, 'now');
    try {
      const scheduler = new WatchRuleScheduler();
      scheduler.add(
        { id: 'r1', deviceId: 'd1', paneId: '%1', triggerType: 'match', intervalSeconds: 5 },
        () => {},
        () => () => {}
      );
      expect(perf).toHaveBeenCalled();
      expect(dateNow).not.toHaveBeenCalled();
    } finally {
      perf.mockRestore();
      dateNow.mockRestore();
    }
  });
});
