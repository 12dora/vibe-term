import { describe, expect, test } from 'bun:test';

import { SnapshotRefreshCoordinator } from './snapshot-refresh-coordinator';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve: (() => void) | null = null;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve: () => resolve?.(),
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for snapshot coordinator');
    }
    await Bun.sleep(5);
  }
}

describe('SnapshotRefreshCoordinator', () => {
  test('coalesces any number of in-flight demands into exactly one trailing run', async () => {
    const gates = [deferred(), deferred()];
    let runs = 0;
    let active = 0;
    let maxActive = 0;
    const coordinator = new SnapshotRefreshCoordinator(
      async () => {
        const index = runs;
        runs += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gates[index]?.promise;
        active -= 1;
      },
      { quietPeriodMs: 0 }
    );

    const first = coordinator.request();
    await waitFor(() => runs === 1);
    const second = coordinator.request();
    const third = coordinator.request();

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(runs).toBe(1);

    gates[0]?.resolve();
    await waitFor(() => runs === 2);
    gates[1]?.resolve();
    await Promise.all([first, second, third]);

    expect(runs).toBe(2);
    expect(maxActive).toBe(1);
  });

  test('resets after a failed run so a later demand can retry', async () => {
    let runs = 0;
    const coordinator = new SnapshotRefreshCoordinator(
      async () => {
        runs += 1;
        if (runs === 1) {
          throw new Error('snapshot failed');
        }
      },
      { quietPeriodMs: 0 }
    );

    await expect(coordinator.request()).rejects.toThrow('snapshot failed');
    await expect(coordinator.request()).resolves.toBeUndefined();
    expect(runs).toBe(2);
  });

  test('quiet period caps structure refreshes under 1s of continuous notifications', async () => {
    let now = 0;
    let runs = 0;
    const waits: Array<{ due: number; resolve: () => void }> = [];
    const coordinator = new SnapshotRefreshCoordinator(
      async () => {
        runs += 1;
      },
      {
        quietPeriodMs: 150,
        now: () => now,
        delay: (ms) =>
          new Promise<void>((resolve) => {
            waits.push({ due: now + ms, resolve });
          }),
      }
    );

    async function tick(ms: number): Promise<void> {
      now += ms;
      const due = waits.filter((item) => item.due <= now);
      const rest = waits.filter((item) => item.due > now);
      waits.length = 0;
      waits.push(...rest);
      for (const item of due) item.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }

    coordinator.request();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(1);

    for (let elapsed = 0; elapsed < 1000; elapsed += 10) {
      coordinator.request();
      await tick(10);
    }

    // 3 commands per refresh（display-message / list-windows / list-panes）
    expect(runs).toBeLessThanOrEqual(7);
    expect(runs * 3).toBeLessThanOrEqual(21);
    expect(runs).toBeGreaterThanOrEqual(6);
  });

  test('requestImmediate skips the quiet period for user commands', async () => {
    let now = 0;
    let runs = 0;
    let delayed = 0;
    const coordinator = new SnapshotRefreshCoordinator(
      async () => {
        runs += 1;
      },
      {
        quietPeriodMs: 150,
        now: () => now,
        delay: (ms) => {
          delayed += ms;
          now += ms;
          return Promise.resolve();
        },
      }
    );

    await coordinator.request();
    expect(runs).toBe(1);
    await coordinator.requestImmediate();
    expect(runs).toBe(2);
    expect(delayed).toBe(0);
  });

  test('requestImmediate during a quiet wait upgrades that run without a trailing refresh', async () => {
    let now = 0;
    let runs = 0;
    const waits: Array<{ due: number; resolve: () => void }> = [];
    const coordinator = new SnapshotRefreshCoordinator(
      async () => {
        runs += 1;
      },
      {
        quietPeriodMs: 150,
        now: () => now,
        delay: (ms) =>
          new Promise<void>((resolve) => {
            waits.push({ due: now + ms, resolve });
          }),
      }
    );

    await coordinator.request();
    expect(runs).toBe(1);

    const structure = coordinator.request();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(1);
    expect(waits).toHaveLength(1);

    const immediate = coordinator.requestImmediate();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.all([structure, immediate]);

    expect(runs).toBe(2);
    now += 150;
    for (const wait of waits) wait.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(2);
  });

  test('finite burst during quiet wait does not schedule a third refresh', async () => {
    let now = 0;
    let runs = 0;
    const waits: Array<{ due: number; resolve: () => void }> = [];
    const firstRefresh = deferred();
    const coordinator = new SnapshotRefreshCoordinator(
      async () => {
        runs += 1;
        if (runs === 1) await firstRefresh.promise;
      },
      {
        quietPeriodMs: 150,
        now: () => now,
        delay: (ms) =>
          new Promise<void>((resolve) => {
            waits.push({ due: now + ms, resolve });
          }),
      }
    );

    const first = coordinator.requestImmediate();
    await waitFor(() => runs === 1);
    coordinator.request();
    coordinator.request();
    firstRefresh.resolve();
    await waitFor(() => waits.length === 1);
    expect(runs).toBe(1);

    coordinator.request();
    coordinator.request();
    now += 150;
    for (const wait of waits.splice(0)) wait.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await first;

    expect(runs).toBe(2);
    now += 150;
    for (const wait of waits.splice(0)) wait.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(2);
  });

  test('same-tick request then requestImmediate upgrades before quiet wait (one refresh)', async () => {
    let now = 0;
    let runs = 0;
    let delayed = 0;
    const coordinator = new SnapshotRefreshCoordinator(
      async () => {
        runs += 1;
      },
      {
        quietPeriodMs: 150,
        now: () => now,
        delay: (ms) => {
          delayed += ms;
          now += ms;
          return Promise.resolve();
        },
      }
    );

    await coordinator.requestImmediate();
    expect(runs).toBe(1);

    const leading = coordinator.request();
    const upgraded = coordinator.requestImmediate();
    expect(upgraded).toBe(leading);
    await Promise.all([leading, upgraded]);

    expect(runs).toBe(2);
    expect(delayed).toBe(0);
  });

  test('requestImmediate during an in-flight refresh still schedules one trailing run', async () => {
    const gate = deferred();
    let runs = 0;
    const coordinator = new SnapshotRefreshCoordinator(
      async () => {
        runs += 1;
        if (runs === 1) await gate.promise;
      },
      { quietPeriodMs: 0 }
    );

    const first = coordinator.requestImmediate();
    await waitFor(() => runs === 1);
    const second = coordinator.requestImmediate();
    expect(second).toBe(first);

    gate.resolve();
    await Promise.all([first, second]);
    expect(runs).toBe(2);
  });
});
