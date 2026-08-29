import { describe, expect, test } from 'bun:test';

import { RetentionKernel } from './kernel';
import { RetentionPolicyScheduler } from './policy-scheduler';
import { PaneReplayStore } from './replay-store';
import type { PaneRetentionMode, PaneState } from './types';

const EPOCH_A = new Uint8Array(16).fill(0x11);
const encoder = new TextEncoder();

function setup(options: ConstructorParameters<typeof RetentionKernel>[0] = {}) {
  const kernel = new RetentionKernel({ scheduleTimers: false, ...options });
  const replay = new PaneReplayStore(kernel);
  const policy = new RetentionPolicyScheduler(kernel);
  return { kernel, replay, policy };
}

function addPane(
  replay: PaneReplayStore,
  kernel: RetentionKernel,
  paneId: string,
  spec: {
    mode: PaneRetentionMode;
    explicitHot?: boolean;
    lastTouchedAt: number;
    bytes?: string;
    receivedAt?: number;
    checkpoint?: string;
  }
): PaneState {
  const state = replay.createPane(paneId, EPOCH_A, true);
  state.mode = spec.mode;
  state.explicitHot = spec.explicitHot ?? false;
  state.lastTouchedAt = spec.lastTouchedAt;
  kernel.panes.set(paneId, state);
  if (spec.bytes) replay.append(state, encoder.encode(spec.bytes), spec.receivedAt ?? 0);
  if (spec.checkpoint) {
    state.checkpoint = {
      paneId,
      paneEpoch: EPOCH_A,
      baseSeq: state.latestSeq,
      rows: 1,
      cols: spec.checkpoint.length,
      modes: 0,
      data: encoder.encode(spec.checkpoint),
      historyCursor: null,
      capturedAt: 0,
    };
  }
  return state;
}

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
});

describe('enforceBounds', () => {
  test.each([
    {
      name: 'keeps the most recently touched implicit hot pane when one slot remains',
      maxHotPanes: 2,
      panes: [
        { paneId: '%e', mode: 'hot' as const, explicitHot: true, lastTouchedAt: 1, bytes: 'eeee' },
        { paneId: '%old', mode: 'hot' as const, lastTouchedAt: 2, bytes: 'old!' },
        { paneId: '%new', mode: 'hot' as const, lastTouchedAt: 3, bytes: 'new!' },
      ],
      expectHot: ['%e', '%new'],
      expectCold: ['%old'],
      hotLimit: 1,
    },
    {
      name: 'makes every implicit hot pane cold when explicit hot already fills the cap',
      maxHotPanes: 1,
      panes: [
        { paneId: '%e', mode: 'hot' as const, explicitHot: true, lastTouchedAt: 5, bytes: 'exp!' },
        { paneId: '%i', mode: 'hot' as const, lastTouchedAt: 9, bytes: 'imp!' },
      ],
      expectHot: ['%e'],
      expectCold: ['%i'],
      hotLimit: 1,
    },
    {
      name: 'does not evict when implicit hot count equals remaining slots',
      maxHotPanes: 2,
      panes: [
        { paneId: '%a', mode: 'hot' as const, lastTouchedAt: 1, bytes: 'aaaa' },
        { paneId: '%b', mode: 'hot' as const, lastTouchedAt: 2, bytes: 'bbbb' },
      ],
      expectHot: ['%a', '%b'],
      expectCold: [],
      hotLimit: 0,
    },
  ])('$name', ({ maxHotPanes, panes, expectHot, expectCold, hotLimit }) => {
    const { kernel, replay, policy } = setup({ maxHotPanes, maxRetentionBytes: 1_000 });
    const states = panes.map((pane) => addPane(replay, kernel, pane.paneId, pane));
    policy.enforceBounds(0);
    expect(
      states
        .filter((state) => state.mode === 'hot')
        .map((state) => state.paneId)
        .sort()
    ).toEqual([...expectHot].sort());
    expect(
      states
        .filter((state) => state.mode === 'cold')
        .map((state) => state.paneId)
        .sort()
    ).toEqual([...expectCold].sort());
    expect(kernel.evictionsByReason.hot_limit).toBe(hotLimit);
  });

  test('retainedBytes === maxRetentionBytes does not evict; one extra byte does', () => {
    const equal = setup({ maxRetentionBytes: 4, maxReplayBytesPerPane: 16 });
    const equalPane = addPane(equal.replay, equal.kernel, '%1', {
      mode: 'active',
      lastTouchedAt: 1,
      bytes: 'abcd',
    });
    equal.policy.enforceBounds(0);
    expect(equalPane.mode).toBe('active');
    expect(equalPane.replayBytes).toBe(4);
    expect(equal.kernel.evictions).toBe(0);

    const over = setup({ maxRetentionBytes: 4, maxReplayBytesPerPane: 16 });
    const overPane = addPane(over.replay, over.kernel, '%1', {
      mode: 'hot',
      lastTouchedAt: 1,
      bytes: 'abcde',
    });
    over.policy.enforceBounds(0);
    expect(overPane.mode).toBe('cold');
    expect(overPane.replayBytes).toBe(0);
    expect(over.kernel.evictionsByReason.retention_limit_replay).toBe(1);
  });

  test('drops implicit-hot panes before checkpoints, then oldest replay chunks', () => {
    const { kernel, replay, policy } = setup({
      maxRetentionBytes: 6,
      maxReplayBytesPerPane: 32,
      maxCheckpointBytesPerPane: 32,
    });
    const implicit = addPane(replay, kernel, '%i', {
      mode: 'hot',
      lastTouchedAt: 1,
      bytes: 'iiii',
      checkpoint: 'IIII',
    });
    const activeOld = addPane(replay, kernel, '%a', {
      mode: 'active',
      lastTouchedAt: 1,
      bytes: 'aaaa',
      receivedAt: 10,
      checkpoint: 'AAAA',
    });
    const activeNew = addPane(replay, kernel, '%b', {
      mode: 'active',
      lastTouchedAt: 2,
      bytes: 'bbbb',
      receivedAt: 20,
      checkpoint: 'BBBB',
    });
    policy.enforceBounds(0);
    expect(implicit.mode).toBe('cold');
    expect(implicit.checkpoint).toBeNull();
    expect(activeOld.checkpoint).toBeNull();
    expect(activeNew.checkpoint).toBeNull();
    expect(decoderOrBytes(activeOld)).toBe('');
    expect(decoderOrBytes(activeNew)).toBe('bbbb');
    expect(kernel.evictionsByReason.retention_limit_replay).toBe(2);
    expect(kernel.evictionsByReason.retention_limit_checkpoint).toBe(2);
  });

  test('explicit hot is never makeCold via the implicit hot cap', () => {
    const { kernel, replay, policy } = setup({ maxHotPanes: 0, maxRetentionBytes: 1_000 });
    const explicit = addPane(replay, kernel, '%e', {
      mode: 'hot',
      explicitHot: true,
      lastTouchedAt: 1,
      bytes: 'keep',
    });
    policy.enforceBounds(0);
    expect(explicit.mode).toBe('hot');
    expect(explicit.explicitHot).toBe(true);
    expect(explicit.replayBytes).toBe(4);
    expect(kernel.evictionsByReason.hot_limit).toBe(0);
  });
});

function decoderOrBytes(state: PaneState): string {
  return new TextDecoder().decode(
    state.replay.reduce((all, chunk) => {
      const next = new Uint8Array(all.byteLength + chunk.data.byteLength);
      next.set(all);
      next.set(chunk.data, all.byteLength);
      return next;
    }, new Uint8Array())
  );
}
