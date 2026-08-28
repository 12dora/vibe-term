import { copyBytes } from './bytes';
import type { RetentionKernel } from './kernel';
import type { RetentionPolicyScheduler } from './policy-scheduler';
import type { PaneReplayStore } from './replay-store';
import {
  type SubscriptionDecision,
  type SubscriptionPlan,
  applyResultFromPlan,
  decideSubscription,
  planSubscription,
} from './subscription-plan';
import type { ConsumerState, PaneSubscriptionApplyResult, PaneSubscriptionRequest } from './types';

export class PaneSubscriptionGenerationConflictError extends Error {
  constructor(generation: bigint) {
    super(`subscription generation ${generation} was reused with different contents`);
    this.name = 'PaneSubscriptionGenerationConflictError';
  }
}

export class PaneSubscriptionCoordinator {
  constructor(
    private readonly kernel: RetentionKernel,
    private readonly replay: PaneReplayStore,
    private readonly policy: RetentionPolicyScheduler
  ) {}

  apply(
    consumer: ConsumerState,
    generation: bigint,
    requestedActive: readonly PaneSubscriptionRequest[],
    requestedHot: readonly PaneSubscriptionRequest[]
  ): PaneSubscriptionApplyResult {
    if (this.kernel.disposed || consumer.closed)
      throw new Error('pane retention consumer is closed');
    const decision = decideSubscription(consumer, generation, requestedActive, requestedHot);
    if (decision.kind === 'conflict') {
      throw new PaneSubscriptionGenerationConflictError(generation);
    }
    if (decision.kind === 'reuse') {
      return this.currentApplyResult(consumer);
    }
    const now = this.kernel.now();
    this.policy.sweep(now);
    const plan = this.buildPlan(consumer, generation, decision);
    this.commit(consumer, plan, now);
    return applyResultFromPlan(plan);
  }

  closeConsumer(consumer: ConsumerState): void {
    if (consumer.closed) return;
    consumer.closed = true;
    this.kernel.consumers.delete(consumer.id);
    consumer.active.clear();
    consumer.hot.clear();
    this.policy.refreshModes(this.kernel.now());
  }

  currentApplyResult(consumer: ConsumerState): PaneSubscriptionApplyResult {
    return {
      generation: consumer.generation ?? 0n,
      activePanes: Array.from(consumer.active.values(), (request) => ({
        paneId: request.paneId,
        paneEpoch: copyBytes(request.paneEpoch),
      })),
      hotPanes: Array.from(consumer.hot.values(), (request) => ({
        paneId: request.paneId,
        paneEpoch: copyBytes(request.paneEpoch),
      })),
      rejected: [],
      replay: [],
    };
  }

  private buildPlan(
    consumer: ConsumerState,
    generation: bigint,
    decision: Extract<SubscriptionDecision, { kind: 'commit' }>
  ): SubscriptionPlan {
    return planSubscription({
      generation,
      requestedActive: decision.activeRequests,
      requestedHot: decision.hotRequests,
      panes: this.kernel.panes,
      otherActive: this.policy.unionPaneIds('active', consumer.id),
      otherHot: this.policy.unionPaneIds('hot', consumer.id),
      maxActivePanes: this.kernel.maxActivePanes,
      maxHotPanes: this.kernel.maxHotPanes,
      buildReplay: (request) => this.replay.buildReplayPlan(request),
    });
  }

  private commit(consumer: ConsumerState, plan: SubscriptionPlan, now: number): void {
    consumer.generation = plan.generation;
    consumer.fingerprint = plan.fingerprint;
    consumer.active = requestMap(plan.accepted.active);
    consumer.hot = requestMap(plan.accepted.hot);
    this.touchAccepted(plan, now);
    this.policy.refreshModes(now);
  }

  private touchAccepted(plan: SubscriptionPlan, now: number): void {
    for (const request of [...plan.accepted.active, ...plan.accepted.hot]) {
      const state = this.kernel.panes.get(request.paneId);
      if (state) state.lastTouchedAt = now;
    }
  }
}

function requestMap(
  requests: readonly PaneSubscriptionRequest[]
): Map<string, PaneSubscriptionRequest> {
  return new Map(requests.map((request) => [request.paneId, request]));
}
