import { describe, expect, test } from 'bun:test';

import { RetentionKernel } from './kernel';
import { RetentionPolicyScheduler } from './policy-scheduler';
import { PaneReplayStore } from './replay-store';
import {
  PaneSubscriptionCoordinator,
  PaneSubscriptionGenerationConflictError,
} from './subscription-coordinator';
import type { ConsumerState } from './types';

const EPOCH_A = new Uint8Array(16).fill(0x11);
const EPOCH_B = new Uint8Array(16).fill(0x22);

function consumer(): ConsumerState {
  return {
    id: 1,
    callbacks: { onData: () => {} },
    generation: null,
    fingerprint: null,
    active: new Map(),
    hot: new Map(),
    closed: false,
  };
}

describe('pane subscription coordinator', () => {
  test('keeps generation monotonic, idempotent, and rejects conflicting reuse', () => {
    const kernel = new RetentionKernel({ scheduleTimers: false });
    const replay = new PaneReplayStore(kernel);
    const policy = new RetentionPolicyScheduler(kernel);
    const coordinator = new PaneSubscriptionCoordinator(kernel, replay, policy);
    kernel.panes.set('%1', replay.createPane('%1', EPOCH_A, true));
    const state = consumer();
    kernel.consumers.set(state.id, state);

    const applied = coordinator.apply(
      state,
      5n,
      [{ paneId: '%1', paneEpoch: EPOCH_A, cursor: null }],
      []
    );
    expect(applied.generation).toBe(5n);
    expect(
      coordinator.apply(state, 5n, [{ paneId: '%1', paneEpoch: EPOCH_A, cursor: null }], [])
        .generation
    ).toBe(5n);
    expect(coordinator.apply(state, 4n, [], []).generation).toBe(5n);
    expect(() => coordinator.apply(state, 5n, [], [])).toThrow(
      PaneSubscriptionGenerationConflictError
    );
  });

  test('replays active panes before hot panes and drops hot duplicates of active ids', () => {
    const kernel = new RetentionKernel({ scheduleTimers: false });
    const replay = new PaneReplayStore(kernel);
    const policy = new RetentionPolicyScheduler(kernel);
    const coordinator = new PaneSubscriptionCoordinator(kernel, replay, policy);
    kernel.panes.set('%1', replay.createPane('%1', EPOCH_A, true));
    kernel.panes.set('%2', replay.createPane('%2', EPOCH_B, true));
    const state = consumer();
    kernel.consumers.set(state.id, state);

    const result = coordinator.apply(
      state,
      1n,
      [{ paneId: '%1', paneEpoch: EPOCH_A, cursor: null }],
      [
        { paneId: '%1', paneEpoch: EPOCH_A, cursor: null },
        { paneId: '%2', paneEpoch: EPOCH_B, cursor: null },
      ]
    );
    expect(result.activePanes.map((pane) => pane.paneId)).toEqual(['%1']);
    expect(result.hotPanes.map((pane) => pane.paneId)).toEqual(['%2']);
    expect(result.replay.map((plan) => plan.paneId)).toEqual(['%1', '%2']);
  });
});
