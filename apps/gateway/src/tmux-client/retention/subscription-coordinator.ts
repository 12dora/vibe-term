import {
  bytesEqual,
  cloneRequest,
  copyBytes,
  subscriptionFingerprint,
  uniqueRequests,
} from './bytes';
import type { RetentionKernel } from './kernel';
import type { RetentionPolicyScheduler } from './policy-scheduler';
import type { PaneReplayStore } from './replay-store';
import type {
  ConsumerState,
  PaneState,
  PaneSubscriptionApplyResult,
  PaneSubscriptionRejection,
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
    const rejected: PaneSubscriptionRejection[] = [];
    const otherActive = this.policy.unionPaneIds('active', consumer.id);
    const otherHot = this.policy.unionPaneIds('hot', consumer.id);
    const prospectiveActive = new Set(otherActive);
    const prospectiveHot = new Set(otherHot);
    const acceptedActive = new Map<string, PaneSubscriptionRequest>();
    const acceptedHot = new Map<string, PaneSubscriptionRequest>();

    for (const request of activeRequests) {
      const state = this.kernel.panes.get(request.paneId);
      const rejection = this.validateRequest(state, request);
      if (rejection) {
        rejected.push({
          paneId: request.paneId,
          paneEpoch: copyBytes(request.paneEpoch),
          reason: rejection,
        });
        continue;
      }
      if (
        !prospectiveActive.has(request.paneId) &&
        prospectiveActive.size >= this.kernel.maxActivePanes
      ) {
        rejected.push({
          paneId: request.paneId,
          paneEpoch: copyBytes(request.paneEpoch),
          reason: 'resource_exhausted',
        });
        continue;
      }
      acceptedActive.set(request.paneId, cloneRequest(request));
      prospectiveActive.add(request.paneId);
    }

    for (const request of hotRequests) {
      const state = this.kernel.panes.get(request.paneId);
      const rejection = this.validateRequest(state, request);
      if (rejection) {
        rejected.push({
          paneId: request.paneId,
          paneEpoch: copyBytes(request.paneEpoch),
          reason: rejection,
        });
        continue;
      }
      if (!prospectiveHot.has(request.paneId) && prospectiveHot.size >= this.kernel.maxHotPanes) {
        rejected.push({
          paneId: request.paneId,
          paneEpoch: copyBytes(request.paneEpoch),
          reason: 'resource_exhausted',
        });
        continue;
      }
      acceptedHot.set(request.paneId, cloneRequest(request));
      prospectiveHot.add(request.paneId);
    }

    consumer.generation = generation;
    consumer.fingerprint = fingerprint;
    consumer.active = acceptedActive;
    consumer.hot = acceptedHot;
    for (const paneId of [...acceptedActive.keys(), ...acceptedHot.keys()]) {
      const state = this.kernel.panes.get(paneId);
      if (state) state.lastTouchedAt = now;
    }
    this.policy.refreshModes(now);

    const replay = [];
    for (const request of [...acceptedActive.values(), ...acceptedHot.values()]) {
      replay.push(this.replay.buildReplayPlan(request));
    }
    return {
      generation,
      activePanes: Array.from(acceptedActive.values(), (request) => ({
        paneId: request.paneId,
        paneEpoch: copyBytes(request.paneEpoch),
      })),
      hotPanes: Array.from(acceptedHot.values(), (request) => ({
        paneId: request.paneId,
        paneEpoch: copyBytes(request.paneEpoch),
      })),
      rejected,
      replay,
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
}
