import { describe, expect, test } from 'bun:test';

import { RetentionKernel } from './kernel';
import { RetentionPolicyScheduler } from './policy-scheduler';
import { PaneReplayStore } from './replay-store';

const EPOCH_A = new Uint8Array(16).fill(0x11);

describe('retention policy scheduler', () => {
  test('dispose clears a scheduled grace timer so later clock advances do nothing', async () => {
    let now = 0;
    const kernel = new RetentionKernel({
      now: () => now,
      scheduleTimers: true,
      routeGraceMs: 20,
    });
    const replay = new PaneReplayStore(kernel);
    const policy = new RetentionPolicyScheduler(kernel);
    const state = replay.createPane('%1', EPOCH_A, true);
    state.mode = 'grace';
    state.graceUntil = 20;
    kernel.panes.set('%1', state);
    policy.scheduleNextDeadline(0);
    kernel.disposed = true;
    policy.dispose();

    now = 50;
    await Bun.sleep(40);
    expect(state.mode).toBe('grace');
    expect(kernel.timer).toBeNull();
  });

  test('snapshotStats is a pure read and does not sweep or re-arm timers', () => {
    let now = 0;
    const kernel = new RetentionKernel({
      now: () => now,
      scheduleTimers: true,
      routeGraceMs: 20,
      replayTtlMs: 50,
    });
    const replay = new PaneReplayStore(kernel);
    const policy = new RetentionPolicyScheduler(kernel);
    const state = replay.createPane('%1', EPOCH_A, true);
    state.mode = 'grace';
    state.graceUntil = 20;
    state.replay = [
      {
        seqStart: 0n,
        seqEnd: 1n,
        data: new Uint8Array([1]),
        receivedAt: 0,
      },
    ];
    state.replayBytes = 1;
    kernel.adjustRetainedBytes(1);
    kernel.panes.set('%1', state);
    policy.scheduleNextDeadline(0);
    const timerBefore = kernel.timer;
    const deadlineBefore = kernel.scheduledDeadline;

    now = 100;
    const stats = policy.snapshotStats();
    expect(stats.gracePanes).toBe(1);
    expect(stats.replayBytes).toBe(1);
    expect(state.mode).toBe('grace');
    expect(state.replay).toHaveLength(1);
    expect(kernel.timer).toBe(timerBefore);
    expect(kernel.scheduledDeadline).toBe(deadlineBefore);
    expect(kernel.evictions).toBe(0);
  });
});
