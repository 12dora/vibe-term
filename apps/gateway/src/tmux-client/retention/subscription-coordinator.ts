import { bytesEqual, copyBytes, subscriptionFingerprint, uniqueRequests } from './bytes';
import type { RetentionKernel } from './kernel';
import type { RetentionPolicyScheduler } from './policy-scheduler';
import type { PaneReplayStore } from './replay-store';
import { acceptSubscriptionRequests } from './subscription-admission';
import type {
  ConsumerState,
  PaneState,
  PaneSubscriptionApplyResult,
  PaneSubscriptionRejectionReason,
  PaneSubscriptionRequest,
} from './types';

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
    const activeRequests = uniqueRequests(requestedActive);
    const activeIds = new Set(activeRequests.map((request) => request.paneId));
    const hotRequests = uniqueRequests(requestedHot).filter(
      (request) => !activeIds.has(request.paneId)
    );
    const fingerprint = subscriptionFingerprint(activeRequests, hotRequests);

    if (consumer.generation !== null && generation < consumer.generation) {
      return this.currentApplyResult(consumer);
    }
    if (consumer.generation === generation) {
      if (consumer.fingerprint !== fingerprint) {
        throw new PaneSubscriptionGenerationConflictError(generation);
      }
      return this.currentApplyResult(consumer);
    }

    const now = this.kernel.now();
    this.policy.sweep(now);
    const activeResult = acceptSubscriptionRequests({
      mode: 'active',
      requests: activeRequests,
      occupied: this.policy.unionPaneIds('active', consumer.id),
      limit: this.kernel.maxActivePanes,
      lookupPane: (paneId) => this.kernel.panes.get(paneId),
      validate: (state, request) => this.validateRequest(state, request),
    });
    const hotResult = acceptSubscriptionRequests({
      mode: 'hot',
      requests: hotRequests,
      occupied: this.policy.unionPaneIds('hot', consumer.id),
      limit: this.kernel.maxHotPanes,
      lookupPane: (paneId) => this.kernel.panes.get(paneId),
      validate: (state, request) => this.validateRequest(state, request),
    });

    consumer.generation = generation;
    consumer.fingerprint = fingerprint;
    consumer.active = activeResult.accepted;
    consumer.hot = hotResult.accepted;
    this.touchAcceptedPanes([...activeResult.accepted.keys(), ...hotResult.accepted.keys()], now);
    this.policy.refreshModes(now);

    return {
      generation,
      activePanes: Array.from(activeResult.accepted.values(), (request) => ({
        paneId: request.paneId,
        paneEpoch: copyBytes(request.paneEpoch),
      })),
      hotPanes: Array.from(hotResult.accepted.values(), (request) => ({
        paneId: request.paneId,
        paneEpoch: copyBytes(request.paneEpoch),
      })),
      rejected: [...activeResult.rejected, ...hotResult.rejected],
      replay: [...activeResult.accepted.values(), ...hotResult.accepted.values()].map((request) =>
        this.replay.buildReplayPlan(request)
      ),
    };
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

  validateRequest(
    state: PaneState | undefined,
    request: PaneSubscriptionRequest
  ): PaneSubscriptionRejectionReason | null {
    if (!state?.known) return 'not_found';
    if (!bytesEqual(state.paneEpoch, request.paneEpoch)) return 'epoch_changed';
    return null;
  }

  private touchAcceptedPanes(paneIds: Iterable<string>, now: number): void {
    for (const paneId of paneIds) {
      const state = this.kernel.panes.get(paneId);
      if (state) state.lastTouchedAt = now;
    }
  }
}
