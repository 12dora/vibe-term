import { elapsedIfDue } from '../tmux-client/control-stream-metrics';
import {
  GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES,
  GATEWAY_WS_BACKPRESSURE_TIMEOUT_MS,
  type WebSocketSendGuardStats,
} from './websocket-send-guard';

export const TERMINAL_OUTPUT_METRICS_INTERVAL_MS = 30_000;
export const TERMINAL_OUTPUT_METRICS_CHECK_EVERY = 1024;

export interface TerminalSourceObservation {
  canonical: boolean;
}

export interface CanonicalTerminalQueueStats {
  pendingPaneGaps: number;
  pendingPaneGapLimit: number;
  streamGapsPending: number;
}

export interface TerminalOutputQueueStats {
  websocket: WebSocketSendGuardStats;
  canonical: CanonicalTerminalQueueStats;
}

export interface TerminalOutputMetricsSnapshot {
  intervalMs: number;
  sourceEvents: number;
  sourceBytes: number;
  droppedEvents: number;
  droppedBytes: number;
  canonicalObservedEvents: number;
  canonicalObservedBytes: number;
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
    canonicalObservedEvents: 0,
    canonicalObservedBytes: 0,
    canonicalRecipientDeliveries: 0,
    canonicalRecipientBytes: 0,
    canonicalDeliveryDrops: 0,
    canonicalDeliveryDropBytes: 0,
  };
}

export function emptyTerminalOutputQueueStats(): TerminalOutputQueueStats {
  return {
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
      carriersByKind: {},
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
    if (observed.canonical) {
      this.counters.canonicalObservedEvents += 1;
      this.counters.canonicalObservedBytes += bytes;
      return;
    }
    this.counters.droppedEvents += 1;
    this.counters.droppedBytes += bytes;
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

  isDue(nowMs: number): boolean {
    return elapsedIfDue(nowMs, this.windowStartedAtMs, this.intervalMs) != null;
  }

  takeIfDue(
    nowMs: number,
    queues = emptyTerminalOutputQueueStats()
  ): TerminalOutputMetricsSnapshot | null {
    const elapsedMs = elapsedIfDue(nowMs, this.windowStartedAtMs, this.intervalMs);
    if (elapsedMs == null) {
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
