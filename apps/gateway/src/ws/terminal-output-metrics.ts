import {
  GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS,
  GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES,
  GATEWAY_TERM_OUTPUT_BATCH_TOTAL_MAX_BYTES,
  type TerminalOutputBatcherStats,
} from './terminal-output-batcher';
import {
  GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES,
  GATEWAY_WS_BACKPRESSURE_TIMEOUT_MS,
  type WebSocketSendGuardStats,
} from './websocket-send-guard';

export const TERMINAL_OUTPUT_METRICS_INTERVAL_MS = 30_000;

export interface TerminalSourceObservation {
  legacy: boolean;
  canonical: boolean;
}

export interface CanonicalTerminalQueueStats {
  pendingPaneGaps: number;
  pendingPaneGapLimit: number;
  streamGapsPending: number;
}

export interface TerminalOutputQueueStats {
  batch: TerminalOutputBatcherStats;
  websocket: WebSocketSendGuardStats;
  canonical: CanonicalTerminalQueueStats;
}

export interface TerminalOutputMetricsSnapshot {
  intervalMs: number;
  sourceEvents: number;
  sourceBytes: number;
  droppedEvents: number;
  droppedBytes: number;
  legacyObservedEvents: number;
  legacyObservedBytes: number;
  canonicalObservedEvents: number;
  canonicalObservedBytes: number;
  batches: number;
  batchBytes: number;
  recipientDeliveries: number;
  recipientBytes: number;
  canonicalRecipientDeliveries: number;
  canonicalRecipientBytes: number;
  canonicalDeliveryDrops: number;
  canonicalDeliveryDropBytes: number;
  queues: TerminalOutputQueueStats;
}

type TerminalOutputCounters = Omit<TerminalOutputMetricsSnapshot, 'intervalMs' | 'queues'>;

function emptyCounters(): TerminalOutputCounters {
  return {
    sourceEvents: 0,
    sourceBytes: 0,
    droppedEvents: 0,
    droppedBytes: 0,
    legacyObservedEvents: 0,
    legacyObservedBytes: 0,
    canonicalObservedEvents: 0,
    canonicalObservedBytes: 0,
    batches: 0,
    batchBytes: 0,
    recipientDeliveries: 0,
    recipientBytes: 0,
    canonicalRecipientDeliveries: 0,
    canonicalRecipientBytes: 0,
    canonicalDeliveryDrops: 0,
    canonicalDeliveryDropBytes: 0,
  };
}

export function emptyTerminalOutputQueueStats(): TerminalOutputQueueStats {
  return {
    batch: {
      pendingPanes: 0,
      pendingBytes: 0,
      pendingBytesLimit: GATEWAY_TERM_OUTPUT_BATCH_TOTAL_MAX_BYTES,
      perPaneBytesLimit: GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES,
      deadlineMs: GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS,
    },
    websocket: {
      sessions: 0,
      backpressuredSessions: 0,
      unavailableSessions: 0,
      queuedBytes: 0,
      queuedBytesLimit: 0,
      perSessionBytesLimit: GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES,
      backpressureTimeoutMs: GATEWAY_WS_BACKPRESSURE_TIMEOUT_MS,
      terminationsByReason: {
        backpressure_gap: 0,
        backpressure_timeout: 0,
        dropped_frame: 0,
        oversized_frame: 0,
      },
    },
    canonical: {
      pendingPaneGaps: 0,
      pendingPaneGapLimit: 0,
      streamGapsPending: 0,
    },
  };
}

export class TerminalOutputMetrics {
  private counters = emptyCounters();

  constructor(
    private readonly intervalMs = TERMINAL_OUTPUT_METRICS_INTERVAL_MS,
    private windowStartedAtMs = Date.now()
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error('terminal output metrics interval must be a positive safe integer');
    }
  }

  recordSource(bytes: number, observed: TerminalSourceObservation): void {
    this.counters.sourceEvents += 1;
    this.counters.sourceBytes += bytes;
    if (observed.legacy) {
      this.counters.legacyObservedEvents += 1;
      this.counters.legacyObservedBytes += bytes;
    }
    if (observed.canonical) {
      this.counters.canonicalObservedEvents += 1;
      this.counters.canonicalObservedBytes += bytes;
    }
    if (!observed.legacy && !observed.canonical) {
      this.counters.droppedEvents += 1;
      this.counters.droppedBytes += bytes;
    }
  }

  recordBatch(bytes: number): void {
    this.counters.batches += 1;
    this.counters.batchBytes += bytes;
  }

  recordRecipient(bytes: number): void {
    this.counters.recipientDeliveries += 1;
    this.counters.recipientBytes += bytes;
  }

  recordCanonicalRecipient(bytes: number, delivered: boolean): void {
    if (delivered) {
      this.counters.canonicalRecipientDeliveries += 1;
      this.counters.canonicalRecipientBytes += bytes;
      return;
    }
    this.counters.canonicalDeliveryDrops += 1;
    this.counters.canonicalDeliveryDropBytes += bytes;
  }

  takeIfDue(
    nowMs: number,
    queues = emptyTerminalOutputQueueStats()
  ): TerminalOutputMetricsSnapshot | null {
    const elapsedMs = nowMs - this.windowStartedAtMs;
    if (elapsedMs < this.intervalMs) {
      return null;
    }
    const snapshot = {
      intervalMs: elapsedMs,
      ...this.counters,
      queues,
    };
    this.windowStartedAtMs = nowMs;
    this.counters = emptyCounters();
    return snapshot;
  }
}
