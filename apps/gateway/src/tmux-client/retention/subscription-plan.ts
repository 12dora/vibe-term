import {
  bytesEqual,
  cloneRequest,
  copyBytes,
  subscriptionFingerprint,
  uniqueRequests,
} from './bytes';
import type {
  ConsumerState,
  PaneIdentity,
  PaneReplayPlan,
  PaneState,
  PaneSubscriptionApplyResult,
  PaneSubscriptionRejection,
  PaneSubscriptionRejectionReason,
  PaneSubscriptionRequest,
} from './types';

export type SubscriptionDecision =
  | { kind: 'reuse'; fingerprint: string }
  | { kind: 'conflict'; fingerprint: string }
  | {
      kind: 'commit';
      fingerprint: string;
      activeRequests: PaneSubscriptionRequest[];
      hotRequests: PaneSubscriptionRequest[];
    };

export interface SubscriptionPlanInput {
  generation: bigint;
  requestedActive: readonly PaneSubscriptionRequest[];
  requestedHot: readonly PaneSubscriptionRequest[];
  panes: ReadonlyMap<string, PaneState>;
  otherActive: ReadonlySet<string>;
  otherHot: ReadonlySet<string>;
  maxActivePanes: number;
  maxHotPanes: number;
  buildReplay: (request: PaneSubscriptionRequest) => PaneReplayPlan;
}

export interface SubscriptionPlan {
  generation: bigint;
  fingerprint: string;
  accepted: {
    active: readonly PaneSubscriptionRequest[];
    hot: readonly PaneSubscriptionRequest[];
  };
  rejected: readonly PaneSubscriptionRejection[];
  replay: readonly PaneReplayPlan[];
}

interface NormalizedRequests {
  activeRequests: PaneSubscriptionRequest[];
  hotRequests: PaneSubscriptionRequest[];
  fingerprint: string;
}

interface LaneDecision {
  accepted: PaneSubscriptionRequest[];
  rejected: PaneSubscriptionRejection[];
}

export function decideSubscription(
  consumer: Pick<ConsumerState, 'generation' | 'fingerprint'>,
  generation: bigint,
  requestedActive: readonly PaneSubscriptionRequest[],
  requestedHot: readonly PaneSubscriptionRequest[]
): SubscriptionDecision {
  const normalized = normalizeRequests(requestedActive, requestedHot);
  if (consumer.generation !== null && generation < consumer.generation) {
    return { kind: 'reuse', fingerprint: normalized.fingerprint };
  }
  if (consumer.generation === generation) {
    if (consumer.fingerprint !== normalized.fingerprint) {
      return { kind: 'conflict', fingerprint: normalized.fingerprint };
    }
    return { kind: 'reuse', fingerprint: normalized.fingerprint };
  }
  return {
    kind: 'commit',
    fingerprint: normalized.fingerprint,
    activeRequests: normalized.activeRequests,
    hotRequests: normalized.hotRequests,
  };
}

export function planSubscription(input: SubscriptionPlanInput): SubscriptionPlan {
  const normalized = normalizeRequests(input.requestedActive, input.requestedHot);
  const active = admitLane(
    normalized.activeRequests,
    input.panes,
    input.otherActive,
    input.maxActivePanes
  );
  const hot = admitLane(normalized.hotRequests, input.panes, input.otherHot, input.maxHotPanes);
  const accepted = { active: active.accepted, hot: hot.accepted };
  return {
    generation: input.generation,
    fingerprint: normalized.fingerprint,
    accepted,
    rejected: [...active.rejected, ...hot.rejected],
    replay: [...accepted.active, ...accepted.hot].map(input.buildReplay),
  };
}

export function applyResultFromPlan(plan: SubscriptionPlan): PaneSubscriptionApplyResult {
  return {
    generation: plan.generation,
    activePanes: plan.accepted.active.map(identityOf),
    hotPanes: plan.accepted.hot.map(identityOf),
    rejected: [...plan.rejected],
    replay: [...plan.replay],
  };
}

function normalizeRequests(
  requestedActive: readonly PaneSubscriptionRequest[],
  requestedHot: readonly PaneSubscriptionRequest[]
): NormalizedRequests {
  const activeRequests = uniqueRequests(requestedActive);
  const activeIds = new Set(activeRequests.map((request) => request.paneId));
  const hotRequests = uniqueRequests(requestedHot).filter(
    (request) => !activeIds.has(request.paneId)
  );
  return {
    activeRequests,
    hotRequests,
    fingerprint: subscriptionFingerprint(activeRequests, hotRequests),
  };
}

function admitLane(
  requests: readonly PaneSubscriptionRequest[],
  panes: ReadonlyMap<string, PaneState>,
  occupied: ReadonlySet<string>,
  max: number
): LaneDecision {
  const accepted: PaneSubscriptionRequest[] = [];
  const rejected: PaneSubscriptionRejection[] = [];
  const prospective = new Set(occupied);
  for (const request of requests) {
    const reason = laneRejection(panes.get(request.paneId), request, prospective, max);
    if (reason) {
      rejected.push({
        paneId: request.paneId,
        paneEpoch: copyBytes(request.paneEpoch),
        reason,
      });
      continue;
    }
    accepted.push(cloneRequest(request));
    prospective.add(request.paneId);
  }
  return { accepted, rejected };
}

function laneRejection(
  state: PaneState | undefined,
  request: PaneSubscriptionRequest,
  prospective: ReadonlySet<string>,
  max: number
): PaneSubscriptionRejectionReason | null {
  if (!state?.known) return 'not_found';
  if (!bytesEqual(state.paneEpoch, request.paneEpoch)) return 'epoch_changed';
  if (!prospective.has(request.paneId) && prospective.size >= max) return 'resource_exhausted';
  return null;
}

function identityOf(request: PaneSubscriptionRequest): PaneIdentity {
  return { paneId: request.paneId, paneEpoch: copyBytes(request.paneEpoch) };
}
