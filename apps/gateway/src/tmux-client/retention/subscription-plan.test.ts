import { describe, expect, test } from 'bun:test';

import { bytesEqual } from './bytes';
import { RetentionKernel } from './kernel';
import { PaneReplayStore } from './replay-store';
import {
  type SubscriptionDecision,
  applyResultFromPlan,
  decideSubscription,
  planSubscription,
} from './subscription-plan';
import type {
  ConsumerState,
  PaneReplayGapReason,
  PaneState,
  PaneSubscriptionRejectionReason,
  PaneSubscriptionRequest,
} from './types';

const EPOCH_A = new Uint8Array(16).fill(0x11);
const EPOCH_B = new Uint8Array(16).fill(0x22);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function req(
  paneId: string,
  paneEpoch: Uint8Array,
  terminalSeq: bigint | null = null
): PaneSubscriptionRequest {
  return {
    paneId,
    paneEpoch,
    cursor: terminalSeq === null ? null : { paneEpoch, terminalSeq },
  };
}

function consumerState(
  generation: bigint | null,
  fingerprint: string | null = null
): Pick<ConsumerState, 'generation' | 'fingerprint'> {
  return { generation, fingerprint };
}

interface PaneSpec {
  paneId: string;
  paneEpoch: Uint8Array;
  known?: boolean;
  data?: string;
}

interface DecisionCase {
  name: string;
  consumerGeneration: bigint | null;
  matchFingerprint?: boolean;
  consumerFingerprint?: string | null;
  generation: bigint;
  requestedActive: PaneSubscriptionRequest[];
  requestedHot: PaneSubscriptionRequest[];
  kind: SubscriptionDecision['kind'];
  activeIds?: string[];
  hotIds?: string[];
}

interface ReplayExpect {
  paneId: string;
  needsScreen: boolean;
  gapReason: PaneReplayGapReason | null;
  data?: string[];
}

interface PlanCase {
  name: string;
  requestedActive: PaneSubscriptionRequest[];
  requestedHot: PaneSubscriptionRequest[];
  panes: PaneSpec[];
  otherActive?: string[];
  otherHot?: string[];
  maxActivePanes?: number;
  maxHotPanes?: number;
  dropOldestChunk?: string;
  acceptedActive: string[];
  acceptedHot: string[];
  rejected: Array<{ paneId: string; reason: PaneSubscriptionRejectionReason }>;
  replay: ReplayExpect[];
}

const DECISION_CASES: DecisionCase[] = [
  {
    name: 'stale generation reuses without re-admitting',
    consumerGeneration: 5n,
    consumerFingerprint: 'prev',
    generation: 4n,
    requestedActive: [],
    requestedHot: [],
    kind: 'reuse',
  },
  {
    name: 'same generation and fingerprint is idempotent reuse',
    consumerGeneration: 5n,
    matchFingerprint: true,
    generation: 5n,
    requestedActive: [req('%1', EPOCH_A)],
    requestedHot: [],
    kind: 'reuse',
  },
  {
    name: 'same generation with different contents is a conflict',
    consumerGeneration: 5n,
    consumerFingerprint: 'prev',
    generation: 5n,
    requestedActive: [],
    requestedHot: [],
    kind: 'conflict',
  },
  {
    name: 'newer generation is a commit after unique-and-hot-filter',
    consumerGeneration: 1n,
    consumerFingerprint: 'prev',
    generation: 2n,
    requestedActive: [req('%1', EPOCH_A), req('%1', EPOCH_B)],
    requestedHot: [req('%1', EPOCH_A), req('%2', EPOCH_B), req('%2', EPOCH_A)],
    kind: 'commit',
    activeIds: ['%1'],
    hotIds: ['%2'],
  },
  {
    name: 'first generation commits even at 0n',
    consumerGeneration: null,
    generation: 0n,
    requestedActive: [],
    requestedHot: [],
    kind: 'commit',
    activeIds: [],
    hotIds: [],
  },
];

const PLAN_CASES: PlanCase[] = [
  {
    name: 'dedupe keeps first active and hot ids and drops hot duplicates of active',
    requestedActive: [req('%1', EPOCH_A), req('%1', EPOCH_B)],
    requestedHot: [req('%1', EPOCH_A), req('%2', EPOCH_B), req('%2', EPOCH_A)],
    panes: [
      { paneId: '%1', paneEpoch: EPOCH_A },
      { paneId: '%2', paneEpoch: EPOCH_B },
    ],
    acceptedActive: ['%1'],
    acceptedHot: ['%2'],
    rejected: [],
    replay: [
      { paneId: '%1', needsScreen: true, gapReason: null },
      { paneId: '%2', needsScreen: true, gapReason: null },
    ],
  },
  {
    name: 'unknown and unknown-known panes are not_found; epoch mismatch is epoch_changed',
    requestedActive: [
      req('%missing', EPOCH_A),
      req('%ghost', EPOCH_A),
      req('%1', EPOCH_B),
      req('%2', EPOCH_B),
    ],
    requestedHot: [req('%3', EPOCH_A)],
    panes: [
      { paneId: '%ghost', paneEpoch: EPOCH_A, known: false },
      { paneId: '%1', paneEpoch: EPOCH_A },
      { paneId: '%2', paneEpoch: EPOCH_B },
      { paneId: '%3', paneEpoch: EPOCH_B },
    ],
    acceptedActive: ['%2'],
    acceptedHot: [],
    rejected: [
      { paneId: '%missing', reason: 'not_found' },
      { paneId: '%ghost', reason: 'not_found' },
      { paneId: '%1', reason: 'epoch_changed' },
      { paneId: '%3', reason: 'epoch_changed' },
    ],
    replay: [{ paneId: '%2', needsScreen: true, gapReason: null }],
  },
  {
    name: 'active capacity rejects later panes but shared other-active ids still fit',
    requestedActive: [req('%1', EPOCH_A), req('%2', EPOCH_B), req('%3', EPOCH_A)],
    requestedHot: [],
    panes: [
      { paneId: '%1', paneEpoch: EPOCH_A },
      { paneId: '%2', paneEpoch: EPOCH_B },
      { paneId: '%3', paneEpoch: EPOCH_A },
    ],
    otherActive: ['%1'],
    maxActivePanes: 2,
    acceptedActive: ['%1', '%2'],
    acceptedHot: [],
    rejected: [{ paneId: '%3', reason: 'resource_exhausted' }],
    replay: [
      { paneId: '%1', needsScreen: true, gapReason: null },
      { paneId: '%2', needsScreen: true, gapReason: null },
    ],
  },
  {
    name: 'hot capacity is independent of active and does not consume a slot on not_found',
    requestedActive: [req('%1', EPOCH_A)],
    requestedHot: [req('%missing', EPOCH_A), req('%2', EPOCH_B), req('%3', EPOCH_A)],
    panes: [
      { paneId: '%1', paneEpoch: EPOCH_A },
      { paneId: '%2', paneEpoch: EPOCH_B },
      { paneId: '%3', paneEpoch: EPOCH_A },
    ],
    maxHotPanes: 1,
    acceptedActive: ['%1'],
    acceptedHot: ['%2'],
    rejected: [
      { paneId: '%missing', reason: 'not_found' },
      { paneId: '%3', reason: 'resource_exhausted' },
    ],
    replay: [
      { paneId: '%1', needsScreen: true, gapReason: null },
      { paneId: '%2', needsScreen: true, gapReason: null },
    ],
  },
  {
    name: 'replay range: null cursor, in-range suffix, past-end gap, evicted prefix',
    requestedActive: [
      req('%1', EPOCH_A),
      req('%2', EPOCH_B, 2n),
      req('%3', EPOCH_A, 9n),
      req('%4', EPOCH_B, 1n),
    ],
    requestedHot: [],
    panes: [
      { paneId: '%1', paneEpoch: EPOCH_A, data: 'abcd' },
      { paneId: '%2', paneEpoch: EPOCH_B, data: 'abcd' },
      { paneId: '%3', paneEpoch: EPOCH_A, data: 'abcd' },
      { paneId: '%4', paneEpoch: EPOCH_B, data: 'abcd' },
    ],
    dropOldestChunk: '%4',
    acceptedActive: ['%1', '%2', '%3', '%4'],
    acceptedHot: [],
    rejected: [],
    replay: [
      { paneId: '%1', needsScreen: true, gapReason: null, data: [] },
      { paneId: '%2', needsScreen: false, gapReason: null, data: ['cd'] },
      { paneId: '%3', needsScreen: true, gapReason: 'pane_gap', data: [] },
      { paneId: '%4', needsScreen: true, gapReason: 'cache_evicted', data: [] },
    ],
  },
];

function setupPanes(
  specs: PaneSpec[],
  dropOldestChunk?: string
): {
  panes: Map<string, PaneState>;
  buildReplay: (request: PaneSubscriptionRequest) => ReturnType<PaneReplayStore['buildReplayPlan']>;
} {
  const kernel = new RetentionKernel({ scheduleTimers: false });
  const replay = new PaneReplayStore(kernel);
  for (const spec of specs) {
    const state = replay.createPane(spec.paneId, spec.paneEpoch, spec.known ?? true);
    if (spec.data) {
      state.mode = 'active';
      replay.append(state, encoder.encode(spec.data), 0);
    }
    kernel.panes.set(spec.paneId, state);
  }
  if (dropOldestChunk) {
    const state = kernel.panes.get(dropOldestChunk);
    const dropped = state?.replay.shift();
    if (state && dropped) state.replayBytes -= dropped.data.byteLength;
  }
  return {
    panes: kernel.panes,
    buildReplay: (request) => replay.buildReplayPlan(request),
  };
}

describe('subscription decision', () => {
  for (const decisionCase of DECISION_CASES) {
    test(decisionCase.name, () => {
      const probe = decideSubscription(
        consumerState(null),
        decisionCase.generation,
        decisionCase.requestedActive,
        decisionCase.requestedHot
      );
      const matching = probe.kind === 'commit' ? probe.fingerprint : null;
      const decision = decideSubscription(
        consumerState(
          decisionCase.consumerGeneration,
          decisionCase.matchFingerprint ? matching : (decisionCase.consumerFingerprint ?? null)
        ),
        decisionCase.generation,
        decisionCase.requestedActive,
        decisionCase.requestedHot
      );
      expect(decision.kind).toBe(decisionCase.kind);
      if (decision.kind !== 'commit') return;
      expect(decision.activeRequests.map((request) => request.paneId)).toEqual(
        decisionCase.activeIds ?? []
      );
      expect(decision.hotRequests.map((request) => request.paneId)).toEqual(
        decisionCase.hotIds ?? []
      );
    });
  }
});

describe('subscription plan', () => {
  for (const planCase of PLAN_CASES) {
    test(planCase.name, () => {
      const { panes, buildReplay } = setupPanes(planCase.panes, planCase.dropOldestChunk);
      const plan = planSubscription({
        generation: 7n,
        requestedActive: planCase.requestedActive,
        requestedHot: planCase.requestedHot,
        panes,
        otherActive: new Set(planCase.otherActive ?? []),
        otherHot: new Set(planCase.otherHot ?? []),
        maxActivePanes: planCase.maxActivePanes ?? 32,
        maxHotPanes: planCase.maxHotPanes ?? 8,
        buildReplay,
      });
      expect(plan.generation).toBe(7n);
      expect(plan.accepted.active.map((request) => request.paneId)).toEqual(
        planCase.acceptedActive
      );
      expect(plan.accepted.hot.map((request) => request.paneId)).toEqual(planCase.acceptedHot);
      expect(
        plan.rejected.map((rejection) => ({ paneId: rejection.paneId, reason: rejection.reason }))
      ).toEqual(planCase.rejected);
      expect(
        plan.replay.map((item) => ({
          paneId: item.paneId,
          needsScreen: item.needsScreen,
          gapReason: item.gap?.reason ?? null,
          ...(planCase.replay.some((expected) => expected.data) && {
            data: item.segments.map((segment) => decoder.decode(segment.data)),
          }),
        }))
      ).toEqual(
        planCase.replay.map((expected) => ({
          paneId: expected.paneId,
          needsScreen: expected.needsScreen,
          gapReason: expected.gapReason,
          ...(expected.data && { data: expected.data }),
        }))
      );

      const result = applyResultFromPlan(plan);
      expect(result.generation).toBe(7n);
      expect(result.activePanes.map((pane) => pane.paneId)).toEqual(planCase.acceptedActive);
      expect(result.hotPanes.map((pane) => pane.paneId)).toEqual(planCase.acceptedHot);
      expect(result.rejected).toEqual([...plan.rejected]);
      expect(result.replay).toEqual([...plan.replay]);
      for (const pane of [...result.activePanes, ...result.hotPanes]) {
        const source = [...plan.accepted.active, ...plan.accepted.hot].find(
          (request) => request.paneId === pane.paneId
        );
        expect(source).toBeDefined();
        if (!source) continue;
        expect(bytesEqual(pane.paneEpoch, source.paneEpoch)).toBe(true);
        expect(pane.paneEpoch).not.toBe(source.paneEpoch);
      }
    });
  }
});
