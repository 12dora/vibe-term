import { describe, expect, test } from 'bun:test';

import { RetentionKernel } from './kernel';
import { RetentionPolicyScheduler } from './policy-scheduler';
import { PaneReplayStore } from './replay-store';
import { acceptSubscriptionRequests } from './subscription-admission';
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

  test('rejects requests whose pane epoch does not match the known pane', () => {
    const kernel = new RetentionKernel({ scheduleTimers: false });
    const replay = new PaneReplayStore(kernel);
    const policy = new RetentionPolicyScheduler(kernel);
    const coordinator = new PaneSubscriptionCoordinator(kernel, replay, policy);
    kernel.panes.set('%1', replay.createPane('%1', EPOCH_A, true));
    kernel.panes.set('%2', replay.createPane('%2', EPOCH_B, true));
    const state = consumer();
    kernel.consumers.set(state.id, state);

    const epochA = new Uint8Array(EPOCH_A);
    const result = coordinator.apply(
      state,
      1n,
      [{ paneId: '%1', paneEpoch: epochA, cursor: null }],
      [{ paneId: '%2', paneEpoch: EPOCH_A, cursor: null }]
    );
    expect(result.activePanes.map((pane) => pane.paneId)).toEqual(['%1']);
    expect(result.hotPanes).toEqual([]);
    expect(result.rejected).toEqual([
      { paneId: '%2', paneEpoch: EPOCH_A, reason: 'epoch_changed' },
    ]);
    expect(result.rejected[0]?.paneEpoch).not.toBe(EPOCH_A);
    expect(result.activePanes[0]?.paneEpoch).not.toBe(epochA);
  });

  test('enforces separate active and hot quotas and preserves rejection order', () => {
    const kernel = new RetentionKernel({
      scheduleTimers: false,
      maxActivePanes: 1,
      maxHotPanes: 1,
    });
    const replay = new PaneReplayStore(kernel);
    const policy = new RetentionPolicyScheduler(kernel);
    const coordinator = new PaneSubscriptionCoordinator(kernel, replay, policy);
    kernel.panes.set('%1', replay.createPane('%1', EPOCH_A, true));
    kernel.panes.set('%2', replay.createPane('%2', EPOCH_B, true));
    kernel.panes.set('%3', replay.createPane('%3', EPOCH_A, true));
    kernel.panes.set('%4', replay.createPane('%4', EPOCH_B, true));
    const first = consumer();
    kernel.consumers.set(first.id, first);
    coordinator.apply(
      first,
      1n,
      [{ paneId: '%1', paneEpoch: EPOCH_A, cursor: null }],
      [{ paneId: '%3', paneEpoch: EPOCH_A, cursor: null }]
    );

    const second: ConsumerState = {
      ...consumer(),
      id: 2,
    };
    kernel.consumers.set(second.id, second);
    const result = coordinator.apply(
      second,
      1n,
      [
        { paneId: '%1', paneEpoch: EPOCH_A, cursor: null },
        { paneId: '%2', paneEpoch: EPOCH_B, cursor: null },
      ],
      [
        { paneId: '%3', paneEpoch: EPOCH_A, cursor: null },
        { paneId: '%4', paneEpoch: EPOCH_B, cursor: null },
      ]
    );
    expect(result.activePanes.map((pane) => pane.paneId)).toEqual(['%1']);
    expect(result.hotPanes.map((pane) => pane.paneId)).toEqual(['%3']);
    expect(result.rejected).toEqual([
      { paneId: '%2', paneEpoch: EPOCH_B, reason: 'resource_exhausted' },
      { paneId: '%4', paneEpoch: EPOCH_B, reason: 'resource_exhausted' },
    ]);
  });

  test('throws when the consumer is already closed', () => {
    const kernel = new RetentionKernel({ scheduleTimers: false });
    const replay = new PaneReplayStore(kernel);
    const policy = new RetentionPolicyScheduler(kernel);
    const coordinator = new PaneSubscriptionCoordinator(kernel, replay, policy);
    const state = consumer();
    state.closed = true;
    expect(() => coordinator.apply(state, 1n, [], [])).toThrow('pane retention consumer is closed');
  });
});

describe('acceptSubscriptionRequests', () => {
  test('clones accepted requests, rejects invalid panes, and skips quota for already occupied ids', () => {
    const epoch = new Uint8Array(EPOCH_A);
    const panes = new Map<string, { known: boolean; paneEpoch: Uint8Array }>([
      ['%1', { known: true, paneEpoch: EPOCH_A }],
      ['%2', { known: true, paneEpoch: EPOCH_B }],
      ['%3', { known: false, paneEpoch: EPOCH_A }],
    ]);
    const result = acceptSubscriptionRequests({
      mode: 'active',
      requests: [
        { paneId: '%1', paneEpoch: epoch, cursor: null },
        { paneId: '%2', paneEpoch: EPOCH_A, cursor: null },
        { paneId: '%3', paneEpoch: EPOCH_A, cursor: null },
        { paneId: '%4', paneEpoch: EPOCH_B, cursor: null },
      ],
      occupied: new Set(['%1']),
      limit: 1,
      lookupPane: (paneId) => panes.get(paneId),
      validate: (state, request) => {
        if (!state?.known) return 'not_found';
        if (
          state.paneEpoch.length !== request.paneEpoch.length ||
          state.paneEpoch.some((byte, index) => byte !== request.paneEpoch[index])
        ) {
          return 'epoch_changed';
        }
        return null;
      },
    });
    expect([...result.accepted.keys()]).toEqual(['%1']);
    expect(result.accepted.get('%1')?.paneEpoch).not.toBe(epoch);
    expect(result.rejected.map((item) => [item.paneId, item.reason])).toEqual([
      ['%2', 'epoch_changed'],
      ['%3', 'not_found'],
      ['%4', 'not_found'],
    ]);
  });

  test('rejects overflow panes in request order after the quota is filled', () => {
    const panes = new Map([
      ['%1', { known: true, paneEpoch: EPOCH_A }],
      ['%2', { known: true, paneEpoch: EPOCH_B }],
    ]);
    const result = acceptSubscriptionRequests({
      mode: 'hot',
      requests: [
        { paneId: '%1', paneEpoch: EPOCH_A, cursor: null },
        { paneId: '%2', paneEpoch: EPOCH_B, cursor: null },
      ],
      occupied: new Set(),
      limit: 1,
      lookupPane: (paneId) => panes.get(paneId),
      validate: (state) => (state?.known ? null : 'not_found'),
    });
    expect([...result.accepted.keys()]).toEqual(['%1']);
    expect(result.rejected).toEqual([
      { paneId: '%2', paneEpoch: EPOCH_B, reason: 'resource_exhausted' },
    ]);
    expect(result.rejected[0]?.paneEpoch).not.toBe(EPOCH_B);
  });
});
