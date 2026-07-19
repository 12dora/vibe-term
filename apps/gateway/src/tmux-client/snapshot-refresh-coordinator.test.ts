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
    const coordinator = new SnapshotRefreshCoordinator(async () => {
      const index = runs;
      runs += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gates[index]?.promise;
      active -= 1;
    });

    const first = coordinator.request();
    const second = coordinator.request();
    const third = coordinator.request();

    expect(first).toBe(second);
    expect(second).toBe(third);
    await waitFor(() => runs === 1);
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
    const coordinator = new SnapshotRefreshCoordinator(async () => {
      runs += 1;
      if (runs === 1) {
        throw new Error('snapshot failed');
      }
    });

    await expect(coordinator.request()).rejects.toThrow('snapshot failed');
    await expect(coordinator.request()).resolves.toBeUndefined();
    expect(runs).toBe(2);
  });
});
