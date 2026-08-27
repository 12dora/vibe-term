import type { CanonicalFeedSession } from './canonical-feed-session';
import {
  type GatewayActivityMetrics,
  collectCanonicalStateMetrics,
} from './gateway-activity-metrics';
import type { GatewaySession } from './gateway-session';
import type { TerminalOutputBatcher } from './terminal-output-batcher';
import type { TerminalOutputMetrics } from './terminal-output-metrics';
import type { DeviceConnectionEntry } from './types';
import { gatewayWebSocketSendGuard } from './websocket-send-guard';

export interface GatewayMetricsHost {
  readonly connectedClients: Set<GatewaySession>;
  readonly connections: Map<string, DeviceConnectionEntry>;
  readonly canonicalSessions: Map<GatewaySession, CanonicalFeedSession>;
  readonly terminalOutputBatcher: TerminalOutputBatcher;
  readonly terminalOutputMetrics: TerminalOutputMetrics;
  readonly gatewayActivityMetrics: GatewayActivityMetrics;
}

export function logTerminalOutputMetricsIfDue(host: GatewayMetricsHost): void {
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
  const wsTerminationReasons = Object.entries(metrics.queues.websocket.terminationsByReason)
    .map(([reason, count]) => `${reason}:${count}`)
    .join(',');
  console.log(
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
      `clients=${host.connectedClients.size} devices=${host.connections.size}`
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
  console.log(
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
      `other:${otherClients},unnegotiated:${unnegotiatedClients}`
  );
}
