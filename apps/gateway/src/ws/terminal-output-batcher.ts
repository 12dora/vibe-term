export const GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS = 16;
export const GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES = 64 * 1024;
export const GATEWAY_TERM_OUTPUT_BATCH_TOTAL_MAX_BYTES = 8 * 1024 * 1024;

export interface TerminalOutputBatcherStats {
  pendingPanes: number;
  pendingBytes: number;
  pendingBytesLimit: number;
  perPaneBytesLimit: number;
  deadlineMs: number;
}

interface PendingBatch {
  data: Uint8Array;
  length: number;
  timer: unknown;
}

type OutputSink = (deviceId: string, paneId: string, data: Uint8Array) => void;

export interface TerminalOutputBatchScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

interface TerminalOutputBatcherOptions {
  delayMs?: number;
  maxBytes?: number;
  totalMaxBytes?: number;
  scheduler?: TerminalOutputBatchScheduler;
}

const defaultScheduler: TerminalOutputBatchScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const INITIAL_BATCH_CAPACITY_BYTES = 1024;

export class TerminalOutputBatcher {
  private readonly pending = new Map<string, Map<string, PendingBatch>>();
  private readonly delayMs: number;
  private readonly maxBytes: number;
  private readonly totalMaxBytes: number;
  private readonly scheduler: TerminalOutputBatchScheduler;
  private pendingBytes = 0;

  constructor(
    private readonly emit: OutputSink,
    options: TerminalOutputBatcherOptions = {}
  ) {
    this.delayMs = options.delayMs ?? GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS;
    this.maxBytes = options.maxBytes ?? GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES;
    this.totalMaxBytes = options.totalMaxBytes ?? GATEWAY_TERM_OUTPUT_BATCH_TOTAL_MAX_BYTES;
    this.scheduler = options.scheduler ?? defaultScheduler;
    if (!Number.isSafeInteger(this.delayMs) || this.delayMs <= 0) {
      throw new Error('terminal output batch delay must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error('terminal output batch limit must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.totalMaxBytes) || this.totalMaxBytes < this.maxBytes) {
      throw new Error('terminal output total batch limit must cover one pane batch');
    }
  }

  push(deviceId: string, paneId: string, data: Uint8Array): void {
    let offset = 0;
    while (offset < data.length) {
      if (this.pendingBytes >= this.totalMaxBytes) {
        this.flushOldest();
        continue;
      }
      const batch = this.getOrCreateBatch(deviceId, paneId);
      const count = Math.min(
        this.maxBytes - batch.length,
        this.totalMaxBytes - this.pendingBytes,
        data.length - offset
      );
      this.ensureCapacity(batch, batch.length + count);
      if (offset === 0 && count === data.length) {
        batch.data.set(data, batch.length);
      } else {
        batch.data.set(data.subarray(offset, offset + count), batch.length);
      }
      batch.length += count;
      this.pendingBytes += count;
      offset += count;
      if (batch.length === this.maxBytes) {
        this.flush(deviceId, paneId, batch);
      }
    }
  }

  flushDevice(deviceId: string): void {
    const panes = this.pending.get(deviceId);
    if (!panes) return;
    for (const [paneId, batch] of [...panes]) {
      this.flush(deviceId, paneId, batch);
    }
  }

  discardDevice(deviceId: string): void {
    const panes = this.pending.get(deviceId);
    if (panes) {
      for (const batch of panes.values()) {
        this.scheduler.cancel(batch.timer);
        this.pendingBytes -= batch.length;
      }
    }
    this.pending.delete(deviceId);
  }

  snapshotStats(): TerminalOutputBatcherStats {
    let pendingPanes = 0;
    for (const panes of this.pending.values()) pendingPanes += panes.size;
    return {
      pendingPanes,
      pendingBytes: this.pendingBytes,
      pendingBytesLimit: this.totalMaxBytes,
      perPaneBytesLimit: this.maxBytes,
      deadlineMs: this.delayMs,
    };
  }

  private getOrCreateBatch(deviceId: string, paneId: string): PendingBatch {
    let panes = this.pending.get(deviceId);
    if (!panes) {
      panes = new Map();
      this.pending.set(deviceId, panes);
    }
    const existing = panes.get(paneId);
    if (existing) {
      return existing;
    }

    const batch: PendingBatch = {
      data: new Uint8Array(Math.min(this.maxBytes, INITIAL_BATCH_CAPACITY_BYTES)),
      length: 0,
      timer: this.scheduler.schedule(() => {
        this.flush(deviceId, paneId, batch);
      }, this.delayMs),
    };
    panes.set(paneId, batch);
    return batch;
  }

  private ensureCapacity(batch: PendingBatch, requiredBytes: number): void {
    if (requiredBytes <= batch.data.length) {
      return;
    }
    let capacity = batch.data.length;
    while (capacity < requiredBytes) {
      capacity = Math.min(this.maxBytes, capacity * 2);
    }
    const grown = new Uint8Array(capacity);
    grown.set(batch.data.subarray(0, batch.length));
    batch.data = grown;
  }

  private flush(deviceId: string, paneId: string, batch: PendingBatch): void {
    const panes = this.pending.get(deviceId);
    if (panes?.get(paneId) !== batch) {
      return;
    }
    this.scheduler.cancel(batch.timer);
    panes.delete(paneId);
    if (panes.size === 0) {
      this.pending.delete(deviceId);
    }
    this.pendingBytes -= batch.length;

    if (batch.length === 0) {
      return;
    }
    this.emit(deviceId, paneId, batch.data.subarray(0, batch.length));
  }

  private flushOldest(): void {
    for (const [deviceId, panes] of this.pending) {
      const oldest = panes.entries().next().value as [string, PendingBatch] | undefined;
      if (!oldest) continue;
      this.flush(deviceId, oldest[0], oldest[1]);
      return;
    }
    throw new Error('terminal output batch accounting is inconsistent');
  }
}
