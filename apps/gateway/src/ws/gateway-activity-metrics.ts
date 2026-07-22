import type {
  PaneRetentionEvictionReason,
  PaneRetentionLimits,
  PaneRetentionStats,
} from '../tmux-client/pane-retention';
import type { CanonicalFeedSessionStats } from './canonical-feed-session';

export const GATEWAY_ACTIVITY_METRICS_INTERVAL_MS = 30_000;

export interface CanonicalRuntimeMetrics {
  stats: PaneRetentionStats;
  limits: PaneRetentionLimits;
}

export interface CanonicalStateMetricsSnapshot {
  runtimes: number;
  sessions: number;
  runtimeAttachments: number;
  knownPanes: number;
  activePanes: number;
  activePanesLimit: number;
  gracePanes: number;
  hotPanes: number;
  hotPanesLimit: number;
  coldPanes: number;
  replayBytes: number;
  replayBytesLimit: number;
  checkpointBytes: number;
  checkpointBytesLimit: number;
  retainedBytes: number;
  retainedBytesLimit: number;
  replayHitsTotal: number;
  replayMissesTotal: number;
  rebasesTotal: number;
  evictionsTotal: number;
  evictionsByReason: Record<PaneRetentionEvictionReason, number>;
  screenJobs: number;
  gatedPanes: number;
  pendingPaneGaps: number;
  pendingPaneGapsLimit: number;
  streamGapsPending: number;
  pendingPaneGapOverflowsTotal: number;
  paneGapsSentTotal: number;
  streamGapsSentTotal: number;
  paneDataDropsTotal: number;
  paneDataDropBytesTotal: number;
  screenTransactionsStartedTotal: number;
  screenTransactionsCompletedTotal: number;
  screenTransactionsFailedTotal: number;
  screenTransactionsCancelledTotal: number;
}

export interface GatewayActivityMetricsSnapshot {
  intervalMs: number;
  inboundMessages: number;
  inboundBytes: number;
  inboundKinds: Array<[number, number]>;
  snapshots: number;
  snapshotBytes: number;
  snapshotDeliveries: number;
  terminalHistories: number;
  terminalHistoryBytes: number;
  terminalHistoryDeliveryAttempts: number;
  tmuxEvents: number;
  tmuxEventDeliveryAttempts: number;
  tmuxEventTypes: Array<[string, number]>;
  canonical: CanonicalStateMetricsSnapshot;
}

interface GatewayActivityCounters {
  inboundMessages: number;
  inboundBytes: number;
  snapshots: number;
  snapshotBytes: number;
  snapshotDeliveries: number;
  terminalHistories: number;
  terminalHistoryBytes: number;
  terminalHistoryDeliveryAttempts: number;
  tmuxEvents: number;
  tmuxEventDeliveryAttempts: number;
}

function emptyCounters(): GatewayActivityCounters {
  return {
    inboundMessages: 0,
    inboundBytes: 0,
    snapshots: 0,
    snapshotBytes: 0,
    snapshotDeliveries: 0,
    terminalHistories: 0,
    terminalHistoryBytes: 0,
    terminalHistoryDeliveryAttempts: 0,
    tmuxEvents: 0,
    tmuxEventDeliveryAttempts: 0,
  };
}

function emptyEvictionsByReason(): Record<PaneRetentionEvictionReason, number> {
  return {
    replay_byte_limit: 0,
    replay_ttl: 0,
    hot_limit: 0,
    hot_ttl: 0,
    retention_limit_checkpoint: 0,
    retention_limit_replay: 0,
    epoch_changed: 0,
  };
}

export function collectCanonicalStateMetrics(
  runtimes: Iterable<CanonicalRuntimeMetrics>,
  sessions: Iterable<CanonicalFeedSessionStats>
): CanonicalStateMetricsSnapshot {
  const runtimeList = Array.from(runtimes);
  const sessionList = Array.from(sessions);
  const snapshot: CanonicalStateMetricsSnapshot = {
    runtimes: runtimeList.length,
    sessions: sessionList.length,
    runtimeAttachments: 0,
    knownPanes: 0,
    activePanes: 0,
    activePanesLimit: 0,
    gracePanes: 0,
    hotPanes: 0,
    hotPanesLimit: 0,
    coldPanes: 0,
    replayBytes: 0,
    replayBytesLimit: 0,
    checkpointBytes: 0,
    checkpointBytesLimit: 0,
    retainedBytes: 0,
    retainedBytesLimit: 0,
    replayHitsTotal: 0,
    replayMissesTotal: 0,
    rebasesTotal: 0,
    evictionsTotal: 0,
    evictionsByReason: emptyEvictionsByReason(),
    screenJobs: 0,
    gatedPanes: 0,
    pendingPaneGaps: 0,
    pendingPaneGapsLimit: 0,
    streamGapsPending: 0,
    pendingPaneGapOverflowsTotal: 0,
    paneGapsSentTotal: 0,
    streamGapsSentTotal: 0,
    paneDataDropsTotal: 0,
    paneDataDropBytesTotal: 0,
    screenTransactionsStartedTotal: 0,
    screenTransactionsCompletedTotal: 0,
    screenTransactionsFailedTotal: 0,
    screenTransactionsCancelledTotal: 0,
  };

  for (const { stats, limits } of runtimeList) {
    snapshot.knownPanes += stats.knownPanes;
    snapshot.activePanes += stats.activePanes;
    snapshot.activePanesLimit += limits.maxActivePanes;
    snapshot.gracePanes += stats.gracePanes;
    snapshot.hotPanes += stats.hotPanes;
    snapshot.hotPanesLimit += limits.maxHotPanes;
    snapshot.coldPanes += stats.coldPanes;
    snapshot.replayBytes += stats.replayBytes;
    snapshot.replayBytesLimit += Math.min(
      limits.maxRetentionBytes,
      stats.knownPanes * limits.maxReplayBytesPerPane
    );
    snapshot.checkpointBytes += stats.checkpointBytes;
    snapshot.checkpointBytesLimit += Math.min(
      limits.maxRetentionBytes,
      stats.knownPanes * limits.maxCheckpointBytesPerPane
    );
    snapshot.retainedBytes += stats.retainedBytes;
    snapshot.retainedBytesLimit += limits.maxRetentionBytes;
    snapshot.replayHitsTotal += stats.replayHits;
    snapshot.replayMissesTotal += stats.replayMisses;
    snapshot.rebasesTotal += stats.rebases;
    snapshot.evictionsTotal += stats.evictions;
    for (const reason of Object.keys(snapshot.evictionsByReason) as PaneRetentionEvictionReason[]) {
      snapshot.evictionsByReason[reason] += stats.evictionsByReason[reason];
    }
  }

  for (const stats of sessionList) {
    snapshot.runtimeAttachments += stats.attachedRuntimes;
    snapshot.screenJobs += stats.screenJobs;
    snapshot.gatedPanes += stats.gatedPanes;
    snapshot.pendingPaneGaps += stats.pendingPaneGaps;
    snapshot.pendingPaneGapsLimit += stats.pendingPaneGapLimit;
    snapshot.streamGapsPending += Number(stats.streamGapPending);
    snapshot.pendingPaneGapOverflowsTotal += stats.pendingPaneGapOverflows;
    snapshot.paneGapsSentTotal += stats.paneGapsSent;
    snapshot.streamGapsSentTotal += stats.streamGapsSent;
    snapshot.paneDataDropsTotal += stats.paneDataDrops;
    snapshot.paneDataDropBytesTotal += stats.paneDataDropBytes;
    snapshot.screenTransactionsStartedTotal += stats.screenTransactionsStarted;
    snapshot.screenTransactionsCompletedTotal += stats.screenTransactionsCompleted;
    snapshot.screenTransactionsFailedTotal += stats.screenTransactionsFailed;
    snapshot.screenTransactionsCancelledTotal += stats.screenTransactionsCancelled;
  }
  return snapshot;
}

export class GatewayActivityMetrics {
  private counters = emptyCounters();
  private inboundKinds = new Map<number, number>();
  private tmuxEventTypes = new Map<string, number>();

  constructor(
    private readonly intervalMs = GATEWAY_ACTIVITY_METRICS_INTERVAL_MS,
    private windowStartedAtMs = Date.now()
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error('gateway activity metrics interval must be a positive safe integer');
    }
  }

  recordInbound(kind: number, bytes: number): void {
    this.counters.inboundMessages += 1;
    this.counters.inboundBytes += bytes;
    this.inboundKinds.set(kind, (this.inboundKinds.get(kind) ?? 0) + 1);
  }

  recordSnapshot(bytes: number, deliveries: number): void {
    this.counters.snapshots += 1;
    this.counters.snapshotBytes += bytes;
    this.counters.snapshotDeliveries += deliveries;
  }

  recordTerminalHistory(bytes: number, deliveryAttempts: number): void {
    this.counters.terminalHistories += 1;
    this.counters.terminalHistoryBytes += bytes;
    this.counters.terminalHistoryDeliveryAttempts += deliveryAttempts;
  }

  recordTmuxEvent(type: string, deliveryAttempts: number): void {
    this.counters.tmuxEvents += 1;
    this.counters.tmuxEventDeliveryAttempts += deliveryAttempts;
    this.tmuxEventTypes.set(type, (this.tmuxEventTypes.get(type) ?? 0) + 1);
  }

  takeIfDue(
    nowMs: number,
    canonical = collectCanonicalStateMetrics([], [])
  ): GatewayActivityMetricsSnapshot | null {
    const elapsedMs = nowMs - this.windowStartedAtMs;
    if (elapsedMs < this.intervalMs) {
      return null;
    }
    const snapshot = {
      intervalMs: elapsedMs,
      ...this.counters,
      inboundKinds: [...this.inboundKinds.entries()].sort(([left], [right]) => left - right),
      tmuxEventTypes: [...this.tmuxEventTypes.entries()].sort(([left], [right]) =>
        left.localeCompare(right)
      ),
      canonical,
    };
    this.windowStartedAtMs = nowMs;
    this.counters = emptyCounters();
    this.inboundKinds = new Map();
    this.tmuxEventTypes = new Map();
    return snapshot;
  }
}
