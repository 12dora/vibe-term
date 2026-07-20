export const CONTROL_STREAM_METRICS_INTERVAL_MS = 30_000;

export interface ControlStreamMetricsSnapshot {
  intervalMs: number;
  rawChunks: number;
  rawBytes: number;
  controlOutputs: number;
  controlOutputBytes: number;
  terminalOutputs: number;
  terminalOutputBytes: number;
  titles: number;
  bells: number;
  notifications: number;
  structureChanges: number;
  blocks: number;
}

function emptyCounters(): Omit<ControlStreamMetricsSnapshot, 'intervalMs'> {
  return {
    rawChunks: 0,
    rawBytes: 0,
    controlOutputs: 0,
    controlOutputBytes: 0,
    terminalOutputs: 0,
    terminalOutputBytes: 0,
    titles: 0,
    bells: 0,
    notifications: 0,
    structureChanges: 0,
    blocks: 0,
  };
}

export class ControlStreamMetrics {
  private counters = emptyCounters();

  constructor(
    private readonly intervalMs = CONTROL_STREAM_METRICS_INTERVAL_MS,
    private windowStartedAtMs = Date.now()
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error('control stream metrics interval must be a positive safe integer');
    }
  }

  recordRawChunk(bytes: number): void {
    this.counters.rawChunks += 1;
    this.counters.rawBytes += bytes;
  }

  recordControlOutput(bytes: number): void {
    this.counters.controlOutputs += 1;
    this.counters.controlOutputBytes += bytes;
  }

  recordTerminalOutput(bytes: number): void {
    this.counters.terminalOutputs += 1;
    this.counters.terminalOutputBytes += bytes;
  }

  recordTitle(): void {
    this.counters.titles += 1;
  }

  recordBell(): void {
    this.counters.bells += 1;
  }

  recordNotification(): void {
    this.counters.notifications += 1;
  }

  recordStructureChange(): void {
    this.counters.structureChanges += 1;
  }

  recordBlock(): void {
    this.counters.blocks += 1;
  }

  takeIfDue(nowMs: number): ControlStreamMetricsSnapshot | null {
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
