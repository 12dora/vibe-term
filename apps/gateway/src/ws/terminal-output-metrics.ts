export const TERMINAL_OUTPUT_METRICS_INTERVAL_MS = 30_000;

export interface TerminalOutputMetricsSnapshot {
  intervalMs: number;
  sourceEvents: number;
  sourceBytes: number;
  droppedEvents: number;
  droppedBytes: number;
  batches: number;
  batchBytes: number;
  recipientDeliveries: number;
  recipientBytes: number;
}

function emptyCounters(): Omit<TerminalOutputMetricsSnapshot, 'intervalMs'> {
  return {
    sourceEvents: 0,
    sourceBytes: 0,
    droppedEvents: 0,
    droppedBytes: 0,
    batches: 0,
    batchBytes: 0,
    recipientDeliveries: 0,
    recipientBytes: 0,
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

  recordSource(bytes: number, observed: boolean): void {
    this.counters.sourceEvents += 1;
    this.counters.sourceBytes += bytes;
    if (!observed) {
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

  takeIfDue(nowMs: number): TerminalOutputMetricsSnapshot | null {
    const elapsedMs = nowMs - this.windowStartedAtMs;
    if (elapsedMs < this.intervalMs) {
      return null;
    }
    const snapshot = {
      intervalMs: elapsedMs,
      ...this.counters,
    };
    this.windowStartedAtMs = nowMs;
    this.counters = emptyCounters();
    return snapshot;
  }
}
