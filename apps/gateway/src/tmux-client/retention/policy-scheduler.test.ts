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

  test('trimPaneReplay head cursor matches shift order and bytes on a recorded sequence', () => {
    let now = 0;
    const kernel = new RetentionKernel({
      now: () => now,
      scheduleTimers: false,
      maxReplayBytesPerPane: 8,
      replayTtlMs: 50,
      maxRetentionBytes: 64,
    });
    const replay = new PaneReplayStore(kernel);
    const policy = new RetentionPolicyScheduler(kernel);
    const state = replay.createPane('%1', EPOCH_A, true);
    state.mode = 'active';
    kernel.panes.set('%1', state);

    const events: Array<{ at: number; data: string }> = [
      { at: 0, data: 'aa' },
      { at: 1, data: 'bb' },
      { at: 2, data: 'cc' },
      { at: 3, data: 'dd' },
      { at: 10, data: 'ee' },
      { at: 60, data: 'ff' },
    ];
    const remaining: string[] = [];
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    for (const event of events) {
      now = event.at;
      replay.append(state, encoder.encode(event.data), now);
      policy.trimPaneReplay(state, now);
      remaining.push(
        decoder.decode(
          state.replay.reduce((buf, chunk) => {
            const next = new Uint8Array(buf.length + chunk.data.byteLength);
            next.set(buf);
            next.set(chunk.data, buf.length);
            return next;
          }, new Uint8Array())
        )
      );
    }

    expect(remaining).toEqual(['aa', 'aabb', 'aabbcc', 'aabbccdd', 'bbccddee', 'eeff']);
    expect(state.replay.map((chunk) => decoder.decode(chunk.data))).toEqual(['ee', 'ff']);
    expect(state.replay.map((chunk) => chunk.seqStart)).toEqual([8n, 10n]);
    expect(state.replayBytes).toBe(4);
    expect(kernel.evictionsByReason.replay_byte_limit).toBe(2);
    expect(kernel.evictionsByReason.replay_ttl).toBe(2);
  });

  test('trim of many chunks keeps replay bytes and order identical after compaction', () => {
    let now = 0;
    const kernel = new RetentionKernel({
      now: () => now,
      scheduleTimers: false,
      maxReplayBytesPerPane: 16,
      replayTtlMs: 10_000,
      maxRetentionBytes: 64,
    });
    const replay = new PaneReplayStore(kernel);
    const policy = new RetentionPolicyScheduler(kernel);
    const state = replay.createPane('%1', EPOCH_A, true);
    state.mode = 'active';
    kernel.panes.set('%1', state);
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    for (let i = 0; i < 40; i += 1) {
      now = i;
      replay.append(state, encoder.encode('x'), now);
      policy.trimPaneReplay(state, now);
    }
    expect(state.replayBytes).toBe(16);
    expect(state.replay).toHaveLength(16);
    expect(decoder.decode(state.replay[0]?.data)).toBe('x');
    expect(state.replay[0]?.seqStart).toBe(24n);
    expect(state.replay.at(-1)?.seqEnd).toBe(40n);
  });
});
