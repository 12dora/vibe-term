import { stamp } from '../mesh/mesh-log';
import type { CanonicalFeedSession } from './canonical-feed-session';
import { gatewayEventLoopLag } from './event-loop-lag';
import {
  type GatewayActivityMetrics,
  type GatewayActivityMetricsSnapshot,
  collectCanonicalStateMetrics,
} from './gateway-activity-metrics';
import type { GatewaySession } from './gateway-session';
import type { TerminalOutputBatcher } from './terminal-output-batcher';
import type {
  TerminalOutputMetrics,
  TerminalOutputMetricsSnapshot,
} from './terminal-output-metrics';
import type { DeviceConnectionEntry } from './types';
import { gatewayWebSocketSendGuard } from './websocket-send-guard';
import { carriersByKindLine } from './ws-backpressure-log';

export interface GatewayMetricsHost {
  readonly connectedClients: Set<GatewaySession>;
  readonly connections: Map<string, DeviceConnectionEntry>;
  readonly canonicalSessions: Map<GatewaySession, CanonicalFeedSession>;
  readonly terminalOutputBatcher: TerminalOutputBatcher;
  readonly terminalOutputMetrics: TerminalOutputMetrics;
  readonly gatewayActivityMetrics: GatewayActivityMetrics;
}

export const PING_METRICS_INTERVAL_MS = 30_000;

export type PingSendPath = 'bypassed' | 'queued';

export interface GatewayPingMetricsSnapshot {
  intervalMs: number;
  probes: number;
  serverHandleMsP50: number;
  serverHandleMsMax: number;
  bypassed: number;
  queued: number;
  bufferedMaxBytes: number;
}

export class GatewayPingMetrics {
  private probes = 0;
  private bypassed = 0;
  private queued = 0;
  private bufferedMaxBytes = 0;
  private handleSamples: number[] = [];

  constructor(
    private readonly intervalMs = PING_METRICS_INTERVAL_MS,
    private windowStartedAtMs = Date.now()
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error('ping metrics interval must be a positive safe integer');
    }
  }

  record(input: {
    serverHandleMs: number;
    path: PingSendPath;
    bufferedBytes: number;
  }): void {
    const handleMs = Math.max(0, Math.round(input.serverHandleMs));
    this.probes += 1;
    if (input.path === 'bypassed') this.bypassed += 1;
    else this.queued += 1;
    this.bufferedMaxBytes = Math.max(this.bufferedMaxBytes, Math.max(0, input.bufferedBytes));
    this.handleSamples.push(handleMs);
  }

  takeIfDue(nowMs: number): GatewayPingMetricsSnapshot | null {
    const elapsedMs = nowMs - this.windowStartedAtMs;
    if (elapsedMs < this.intervalMs) {
      return null;
    }
    const snapshot: GatewayPingMetricsSnapshot = {
      intervalMs: elapsedMs,
      probes: this.probes,
      serverHandleMsP50: percentile50(this.handleSamples),
      serverHandleMsMax: this.handleSamples.reduce((max, value) => Math.max(max, value), 0),
      bypassed: this.bypassed,
      queued: this.queued,
      bufferedMaxBytes: this.bufferedMaxBytes,
    };
    this.windowStartedAtMs = nowMs;
    this.probes = 0;
    this.bypassed = 0;
    this.queued = 0;
    this.bufferedMaxBytes = 0;
    this.handleSamples = [];
    return snapshot;
  }
}

export function isQuietPingSnapshot(metrics: GatewayPingMetricsSnapshot): boolean {
  return (
    metrics.probes === 0 &&
    metrics.bypassed === 0 &&
    metrics.queued === 0 &&
    metrics.bufferedMaxBytes === 0 &&
    metrics.serverHandleMsP50 === 0 &&
    metrics.serverHandleMsMax === 0
  );
}

export function isQuietTerminalOutputSnapshot(metrics: TerminalOutputMetricsSnapshot): boolean {
  if (
    metrics.sourceEvents !== 0 ||
    metrics.sourceBytes !== 0 ||
    metrics.droppedEvents !== 0 ||
    metrics.droppedBytes !== 0 ||
    metrics.legacyObservedEvents !== 0 ||
    metrics.legacyObservedBytes !== 0 ||
    metrics.canonicalObservedEvents !== 0 ||
    metrics.canonicalObservedBytes !== 0 ||
    metrics.batches !== 0 ||
    metrics.batchBytes !== 0 ||
    metrics.recipientDeliveries !== 0 ||
    metrics.recipientBytes !== 0 ||
    metrics.canonicalRecipientDeliveries !== 0 ||
    metrics.canonicalRecipientBytes !== 0 ||
    metrics.canonicalDeliveryDrops !== 0 ||
    metrics.canonicalDeliveryDropBytes !== 0
  ) {
    return false;
  }
  const { batch, websocket, canonical } = metrics.queues;
  if (batch.pendingBytes !== 0 || batch.pendingPanes !== 0) return false;
  if (
    websocket.queuedBytes !== 0 ||
    websocket.backpressuredSessions !== 0 ||
    websocket.unavailableSessions !== 0
  ) {
    return false;
  }
  return canonical.pendingPaneGaps === 0 && canonical.streamGapsPending === 0;
}

export function isQuietGatewayActivitySnapshot(metrics: GatewayActivityMetricsSnapshot): boolean {
  return (
    metrics.inboundMessages === 0 &&
    metrics.inboundBytes === 0 &&
    metrics.inboundKinds.length === 0 &&
    metrics.snapshots === 0 &&
    metrics.snapshotBytes === 0 &&
    metrics.snapshotDeliveries === 0 &&
    metrics.terminalHistories === 0 &&
    metrics.terminalHistoryBytes === 0 &&
    metrics.terminalHistoryDeliveryAttempts === 0 &&
    metrics.tmuxEvents === 0 &&
    metrics.tmuxEventDeliveryAttempts === 0 &&
    metrics.tmuxEventTypes.length === 0
  );
}

function percentile50(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = samples.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

let pingMetrics = new GatewayPingMetrics();

export function recordPingProbe(input: {
  serverHandleMs: number;
  path: PingSendPath;
  bufferedBytes: number;
}): void {
  pingMetrics.record(input);
  logPingMetricsIfDue();
}

export function logPingMetricsIfDue(nowMs = Date.now()): void {
  const metrics = pingMetrics.takeIfDue(nowMs);
  if (!metrics) return;
  if (isQuietPingSnapshot(metrics)) return;
  const lag = gatewayEventLoopLag().snapshot();
  console.log(
    stamp(
      `[ws-metrics] ping probes=${metrics.probes} ` +
        `server_handle_ms_p50=${metrics.serverHandleMsP50} ` +
        `server_handle_ms_max=${metrics.serverHandleMsMax} ` +
        `bypassed=${metrics.bypassed} queued=${metrics.queued} ` +
        `buffered_max_bytes=${metrics.bufferedMaxBytes} ` +
        `event_loop_lag_ms=${lag.lagMs}`
    )
  );
}

export function setPingMetricsForTest(metrics: GatewayPingMetrics): void {
  pingMetrics = metrics;
}

export function resetPingMetricsForTest(): void {
  pingMetrics = new GatewayPingMetrics();
}

export function logTerminalOutputMetricsIfDue(host: GatewayMetricsHost): void {
  logPingMetricsIfDue();
  const canonicalSessionStats = Array.from(host.canonicalSessions.values(), (session) =>
    session.snapshotStats()
  );
  const metrics = host.terminalOutputMetrics.takeIfDue(Date.now(), {
    batch: host.terminalOutputBatcher.snapshotStats(),
    websocket: gatewayWebSocketSendGuard.snapshotStats(
      Array.from(host.connectedClients, (session) => session.carriers()).flat()
    ),
    canonical: {
      pendingPaneGaps: canonicalSessionStats.reduce(
        (total, stats) => total + stats.pendingPaneGaps,
        0
      ),
      pendingPaneGapLimit: canonicalSessionStats.reduce(
        (total, stats) => total + stats.pendingPaneGapLimit,
        0
      ),
      streamGapsPending: canonicalSessionStats.reduce(
        (total, stats) => total + Number(stats.streamGapPending),
        0
      ),
    },
  });
  if (!metrics) {
    return;
  }
  if (isQuietTerminalOutputSnapshot(metrics)) {
    logGatewayActivityMetricsIfDue(host);
    return;
  }
  const wsTerminationReasons = Object.entries(metrics.queues.websocket.terminationsByReason)
    .map(([reason, count]) => `${reason}:${count}`)
    .join(',');
  const carrier = carriersByKindLine(metrics.queues.websocket.carriersByKind ?? {});
  console.log(
    stamp(
      `[ws-metrics] terminal_output interval_ms=${metrics.intervalMs} ` +
        `source_events=${metrics.sourceEvents} source_bytes=${metrics.sourceBytes} ` +
        `dropped_events=${metrics.droppedEvents} dropped_bytes=${metrics.droppedBytes} ` +
        `legacy_observed_events=${metrics.legacyObservedEvents} ` +
        `legacy_observed_bytes=${metrics.legacyObservedBytes} ` +
        `canonical_observed_events=${metrics.canonicalObservedEvents} ` +
        `canonical_observed_bytes=${metrics.canonicalObservedBytes} ` +
        `batches=${metrics.batches} batch_bytes=${metrics.batchBytes} ` +
        `recipient_deliveries=${metrics.recipientDeliveries} ` +
        `recipient_bytes=${metrics.recipientBytes} ` +
        `canonical_recipient_deliveries=${metrics.canonicalRecipientDeliveries} ` +
        `canonical_recipient_bytes=${metrics.canonicalRecipientBytes} ` +
        `canonical_delivery_drops=${metrics.canonicalDeliveryDrops} ` +
        `canonical_delivery_drop_bytes=${metrics.canonicalDeliveryDropBytes} ` +
        `batch_queue_bytes=${metrics.queues.batch.pendingBytes} ` +
        `batch_queue_limit_bytes=${metrics.queues.batch.pendingBytesLimit} ` +
        `batch_queue_panes=${metrics.queues.batch.pendingPanes} ` +
        `batch_queue_pane_limit_bytes=${metrics.queues.batch.perPaneBytesLimit} ` +
        `ws_queue_bytes=${metrics.queues.websocket.queuedBytes} ` +
        `ws_queue_limit_bytes=${metrics.queues.websocket.queuedBytesLimit} ` +
        `ws_backpressured_carriers=${metrics.queues.websocket.backpressuredSessions} ` +
        `ws_unavailable_carriers=${metrics.queues.websocket.unavailableSessions} ` +
        `ws_terminations_by_reason=${wsTerminationReasons || 'none'} ` +
        `canonical_pending_gaps=${metrics.queues.canonical.pendingPaneGaps} ` +
        `canonical_pending_gap_limit=${metrics.queues.canonical.pendingPaneGapLimit} ` +
        `canonical_stream_gaps_pending=${metrics.queues.canonical.streamGapsPending} ` +
        `carrier=${carrier} ` +
        `clients=${host.connectedClients.size} devices=${host.connections.size}`
    )
  );
  logGatewayActivityMetricsIfDue(host);
}

export function logGatewayActivityMetricsIfDue(host: GatewayMetricsHost): void {
  const canonicalRuntimes = Array.from(host.connections.values())
    .filter((entry) => (entry.canonicalClients?.size ?? 0) > 0)
    .map((entry) => ({
      stats: entry.runtime.getPaneRetentionStats(),
      limits: entry.runtime.getPaneRetentionLimits(),
    }));
  const canonicalSessions = Array.from(host.canonicalSessions.values(), (session) =>
    session.snapshotStats()
  );
  const canonical = collectCanonicalStateMetrics(canonicalRuntimes, canonicalSessions);
  const metrics = host.gatewayActivityMetrics.takeIfDue(Date.now(), canonical);
  if (!metrics) {
    return;
  }
  if (isQuietGatewayActivitySnapshot(metrics)) {
    return;
  }
  const inboundKinds =
    metrics.inboundKinds
      .map(([kind, count]) => `${kind.toString(16).padStart(4, '0')}:${count}`)
      .join(',') || 'none';
  const tmuxEventTypes =
    metrics.tmuxEventTypes.map(([type, count]) => `${type}:${count}`).join(',') || 'none';
  const cacheEvictionReasons =
    Object.entries(metrics.canonical.evictionsByReason)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(',') || 'none';
  let tmexFeClients = 0;
  let companionClients = 0;
  let otherClients = 0;
  let unnegotiatedClients = 0;
  for (const client of host.connectedClients) {
    const clientImpl = client.borshState.clientImpl;
    if (clientImpl === null) {
      unnegotiatedClients += 1;
    } else if (clientImpl === 'tmex-fe') {
      tmexFeClients += 1;
    } else if (clientImpl === 'vibex-companion') {
      companionClients += 1;
    } else {
      otherClients += 1;
    }
  }
  const lag = gatewayEventLoopLag().snapshot();
  console.log(
    stamp(
      `[ws-metrics] gateway_activity interval_ms=${metrics.intervalMs} ` +
        `inbound_messages=${metrics.inboundMessages} inbound_bytes=${metrics.inboundBytes} ` +
        `inbound_kinds=${inboundKinds} snapshots=${metrics.snapshots} ` +
        `snapshot_bytes=${metrics.snapshotBytes} ` +
        `snapshot_deliveries=${metrics.snapshotDeliveries} ` +
        `terminal_histories=${metrics.terminalHistories} ` +
        `terminal_history_bytes=${metrics.terminalHistoryBytes} ` +
        `terminal_history_delivery_attempts=${metrics.terminalHistoryDeliveryAttempts} ` +
        `tmux_events=${metrics.tmuxEvents} ` +
        `tmux_event_delivery_attempts=${metrics.tmuxEventDeliveryAttempts} ` +
        `tmux_event_types=${tmuxEventTypes} ` +
        `canonical_runtimes=${metrics.canonical.runtimes} ` +
        `canonical_sessions=${metrics.canonical.sessions} ` +
        `canonical_runtime_attachments=${metrics.canonical.runtimeAttachments} ` +
        `canonical_active_panes=${metrics.canonical.activePanes} ` +
        `canonical_active_panes_limit=${metrics.canonical.activePanesLimit} ` +
        `canonical_grace_panes=${metrics.canonical.gracePanes} ` +
        `canonical_hot_panes=${metrics.canonical.hotPanes} ` +
        `canonical_hot_panes_limit=${metrics.canonical.hotPanesLimit} ` +
        `canonical_cold_panes=${metrics.canonical.coldPanes} ` +
        `canonical_replay_bytes=${metrics.canonical.replayBytes} ` +
        `canonical_replay_bytes_limit=${metrics.canonical.replayBytesLimit} ` +
        `canonical_checkpoint_bytes=${metrics.canonical.checkpointBytes} ` +
        `canonical_checkpoint_bytes_limit=${metrics.canonical.checkpointBytesLimit} ` +
        `canonical_retained_bytes=${metrics.canonical.retainedBytes} ` +
        `canonical_retained_bytes_limit=${metrics.canonical.retainedBytesLimit} ` +
        `canonical_replay_hits_total=${metrics.canonical.replayHitsTotal} ` +
        `canonical_replay_misses_total=${metrics.canonical.replayMissesTotal} ` +
        `canonical_rebases_total=${metrics.canonical.rebasesTotal} ` +
        `canonical_evictions_total=${metrics.canonical.evictionsTotal} ` +
        `canonical_evictions_by_reason=${cacheEvictionReasons} ` +
        `canonical_screen_jobs=${metrics.canonical.screenJobs} ` +
        `canonical_gated_panes=${metrics.canonical.gatedPanes} ` +
        `canonical_pending_gaps=${metrics.canonical.pendingPaneGaps} ` +
        `canonical_pending_gap_limit=${metrics.canonical.pendingPaneGapsLimit} ` +
        `canonical_stream_gaps_pending=${metrics.canonical.streamGapsPending} ` +
        `canonical_pending_gap_overflows_total=${metrics.canonical.pendingPaneGapOverflowsTotal} ` +
        `canonical_pane_gaps_sent_total=${metrics.canonical.paneGapsSentTotal} ` +
        `canonical_stream_gaps_sent_total=${metrics.canonical.streamGapsSentTotal} ` +
        `canonical_pane_data_drops_total=${metrics.canonical.paneDataDropsTotal} ` +
        `canonical_pane_data_drop_bytes_total=${metrics.canonical.paneDataDropBytesTotal} ` +
        `canonical_screen_transactions_started_total=${metrics.canonical.screenTransactionsStartedTotal} ` +
        `canonical_screen_transactions_completed_total=${metrics.canonical.screenTransactionsCompletedTotal} ` +
        `canonical_screen_transactions_failed_total=${metrics.canonical.screenTransactionsFailedTotal} ` +
        `canonical_screen_transactions_cancelled_total=${metrics.canonical.screenTransactionsCancelledTotal} ` +
        `client_impls=tmex-fe:${tmexFeClients},vibex-companion:${companionClients},` +
        `other:${otherClients},unnegotiated:${unnegotiatedClients} ` +
        `event_loop_lag_ms=${lag.lagMs} max_lag_ms=${lag.maxLagMs}`
    )
  );
}
