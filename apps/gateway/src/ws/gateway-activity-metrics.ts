export const GATEWAY_ACTIVITY_METRICS_INTERVAL_MS = 30_000;

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

  takeIfDue(nowMs: number): GatewayActivityMetricsSnapshot | null {
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
    };
    this.windowStartedAtMs = nowMs;
    this.counters = emptyCounters();
    this.inboundKinds = new Map();
    this.tmuxEventTypes = new Map();
    return snapshot;
  }
}
