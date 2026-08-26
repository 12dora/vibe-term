import { bytesEqual } from './retention/bytes';
import { RetentionKernel } from './retention/kernel';
import { RetentionPolicyScheduler } from './retention/policy-scheduler';
import { PaneReplayStore } from './retention/replay-store';
import { PaneSubscriptionCoordinator } from './retention/subscription-coordinator';
import type {
  ConsumerState,
  PaneDataSegment,
  PaneHistoryPage,
  PaneIdentity,
  PaneReplayPlan,
  PaneRetentionConsumerCallbacks,
  PaneRetentionLimits,
  PaneRetentionOptions,
  PaneRetentionStats,
  PaneScreenCheckpoint,
  PaneSubscriptionApplyResult,
  PaneSubscriptionRequest,
  PaneTerminalCursor,
} from './retention/types';

export {
  DEFAULT_HOT_TTL_MS,
  DEFAULT_MAX_ACTIVE_PANES,
  DEFAULT_MAX_CHECKPOINT_BYTES_PER_PANE,
  DEFAULT_MAX_HOT_PANES,
  DEFAULT_MAX_REPLAY_BYTES_PER_PANE,
  DEFAULT_MAX_RETENTION_BYTES,
  DEFAULT_REPLAY_TTL_MS,
  DEFAULT_ROUTE_GRACE_MS,
  type PaneDataSegment,
  type PaneHistoryPage,
  type PaneIdentity,
  type PaneReplayGap,
  type PaneReplayGapReason,
  type PaneReplayPlan,
  type PaneRetentionConsumerCallbacks,
  type PaneRetentionEvictionReason,
  type PaneRetentionLimits,
  type PaneRetentionMode,
  type PaneRetentionOptions,
  type PaneRetentionStats,
  type PaneScreenCheckpoint,
  type PaneSubscriptionApplyResult,
  type PaneSubscriptionRejection,
  type PaneSubscriptionRejectionReason,
  type PaneSubscriptionRequest,
  type PaneTerminalCursor,
} from './retention/types';
export { PaneSubscriptionGenerationConflictError } from './retention/subscription-coordinator';

export class PaneRetentionConsumerLease {
  constructor(
    private readonly owner: PaneRetention,
    private readonly state: ConsumerState
  ) {}

  applySubscriptions(
    generation: bigint,
    activePanes: readonly PaneSubscriptionRequest[],
    hotPanes: readonly PaneSubscriptionRequest[]
  ): PaneSubscriptionApplyResult {
    return this.owner.applySubscriptions(this.state, generation, activePanes, hotPanes);
  }

  close(): void {
    this.owner.closeConsumer(this.state);
  }
}

export class PaneRetention {
  private readonly kernel: RetentionKernel;
  private readonly replay: PaneReplayStore;
  private readonly policy: RetentionPolicyScheduler;
  private readonly subscriptions: PaneSubscriptionCoordinator;

  readonly maxActivePanes: number;
  readonly maxHotPanes: number;
  readonly maxCheckpointBytesPerPane: number;

  constructor(options: PaneRetentionOptions = {}) {
    this.kernel = new RetentionKernel(options);
    this.replay = new PaneReplayStore(this.kernel);
    this.policy = new RetentionPolicyScheduler(this.kernel);
    this.subscriptions = new PaneSubscriptionCoordinator(this.kernel, this.replay, this.policy);
    this.maxActivePanes = this.kernel.maxActivePanes;
    this.maxHotPanes = this.kernel.maxHotPanes;
    this.maxCheckpointBytesPerPane = this.kernel.maxCheckpointBytesPerPane;
  }

  attachConsumer(callbacks: PaneRetentionConsumerCallbacks): PaneRetentionConsumerLease {
    if (this.kernel.disposed) throw new Error('pane retention is disposed');
    const state: ConsumerState = {
      id: this.kernel.nextConsumerId++,
      callbacks,
      generation: null,
      fingerprint: null,
      active: new Map(),
      hot: new Map(),
      closed: false,
    };
    this.kernel.consumers.set(state.id, state);
    return new PaneRetentionConsumerLease(this, state);
  }

  reconcilePanes(panes: readonly PaneIdentity[]): void {
    if (this.kernel.disposed) return;
    const seen = new Set<string>();
    for (const pane of panes) {
      seen.add(pane.paneId);
      const state = this.kernel.panes.get(pane.paneId);
      if (!state) {
        this.kernel.panes.set(
          pane.paneId,
          this.replay.createPane(pane.paneId, pane.paneEpoch, true)
        );
        continue;
      }
      state.known = true;
      if (!bytesEqual(state.paneEpoch, pane.paneEpoch)) {
        this.replay.rotatePaneEpoch(state, pane.paneEpoch);
      }
    }

    for (const [paneId, state] of this.kernel.panes) {
      if (!state.known || seen.has(paneId)) continue;
      this.kernel.panes.delete(paneId);
      for (const consumer of this.kernel.consumers.values()) {
        consumer.active.delete(paneId);
        consumer.hot.delete(paneId);
      }
    }
    this.policy.refreshModes(this.kernel.now());
  }

  ingest(paneId: string, paneEpoch: Uint8Array, data: Uint8Array): PaneDataSegment | null {
    if (this.kernel.disposed || data.byteLength === 0) return null;
    const now = this.kernel.now();
    this.policy.sweep(now);
    let state = this.kernel.panes.get(paneId);
    if (!state) {
      state = this.replay.createPane(paneId, paneEpoch, false);
      this.kernel.panes.set(paneId, state);
    } else if (!bytesEqual(state.paneEpoch, paneEpoch)) {
      this.replay.rotatePaneEpoch(state, paneEpoch);
    }

    const segment = this.replay.append(state, data, now);
    this.policy.trimPaneReplay(state, now);
    this.replay.fanout(state, segment);
    this.policy.enforceBounds(now);
    return segment;
  }

  getLatestCursor(paneId: string): PaneTerminalCursor | null {
    return this.replay.getLatestCursor(paneId);
  }

  isPaneRetained(paneId: string): boolean {
    return this.replay.isPaneRetained(paneId);
  }

  snapshotLimits(): PaneRetentionLimits {
    return {
      maxActivePanes: this.kernel.maxActivePanes,
      maxHotPanes: this.kernel.maxHotPanes,
      routeGraceMs: this.kernel.routeGraceMs,
      hotTtlMs: this.kernel.hotTtlMs,
      replayTtlMs: this.kernel.replayTtlMs,
      maxReplayBytesPerPane: this.kernel.maxReplayBytesPerPane,
      maxCheckpointBytesPerPane: this.kernel.maxCheckpointBytesPerPane,
      maxRetentionBytes: this.kernel.maxRetentionBytes,
    };
  }

  readReplay(paneId: string, cursor: PaneTerminalCursor): PaneReplayPlan | null {
    return this.replay.readReplay(paneId, cursor);
  }

  getScreenCheckpoint(paneId: string): PaneScreenCheckpoint | null {
    return this.replay.getScreenCheckpoint(paneId);
  }

  storeScreenCheckpoint(checkpoint: PaneScreenCheckpoint): boolean {
    const stored = this.replay.storeScreenCheckpoint(checkpoint);
    if (!stored) return false;
    this.policy.enforceBounds(this.kernel.now());
    const state = this.kernel.panes.get(checkpoint.paneId);
    return state?.checkpoint !== null;
  }

  readHistory(
    paneId: string,
    beforeCursor: PaneTerminalCursor | null,
    byteLimit: number
  ): PaneHistoryPage | null {
    return this.replay.readHistory(paneId, beforeCursor, byteLimit);
  }

  snapshotStats(): PaneRetentionStats {
    return this.policy.snapshotStats();
  }

  sweep(now = this.kernel.now()): void {
    this.policy.sweep(now);
  }

  dispose(): void {
    if (this.kernel.disposed) return;
    this.kernel.disposed = true;
    this.policy.dispose();
    this.kernel.consumers.clear();
    this.kernel.panes.clear();
  }

  applySubscriptions(
    consumer: ConsumerState,
    generation: bigint,
    requestedActive: readonly PaneSubscriptionRequest[],
    requestedHot: readonly PaneSubscriptionRequest[]
  ): PaneSubscriptionApplyResult {
    return this.subscriptions.apply(consumer, generation, requestedActive, requestedHot);
  }

  closeConsumer(consumer: ConsumerState): void {
    this.subscriptions.closeConsumer(consumer);
  }
}
