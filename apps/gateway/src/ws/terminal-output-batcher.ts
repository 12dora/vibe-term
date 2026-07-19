export const GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS = 8;
export const GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES = 64 * 1024;

interface PendingBatch {
  chunks: Uint8Array[];
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
  scheduler?: TerminalOutputBatchScheduler;
}

const defaultScheduler: TerminalOutputBatchScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class TerminalOutputBatcher {
  private readonly pending = new Map<string, Map<string, PendingBatch>>();
  private readonly delayMs: number;
  private readonly maxBytes: number;
  private readonly scheduler: TerminalOutputBatchScheduler;

  constructor(
    private readonly emit: OutputSink,
    options: TerminalOutputBatcherOptions = {}
  ) {
    this.delayMs = options.delayMs ?? GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS;
    this.maxBytes = options.maxBytes ?? GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES;
    this.scheduler = options.scheduler ?? defaultScheduler;
    if (!Number.isSafeInteger(this.delayMs) || this.delayMs <= 0) {
      throw new Error('terminal output batch delay must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error('terminal output batch limit must be a positive safe integer');
    }
  }

  push(deviceId: string, paneId: string, data: Uint8Array): void {
    let offset = 0;
    while (offset < data.length) {
      const batch = this.getOrCreateBatch(deviceId, paneId);
      const count = Math.min(this.maxBytes - batch.length, data.length - offset);
      batch.chunks.push(data.subarray(offset, offset + count));
      batch.length += count;
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
      }
    }
    this.pending.delete(deviceId);
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
      chunks: [],
      length: 0,
      timer: this.scheduler.schedule(() => {
        this.flush(deviceId, paneId, batch);
      }, this.delayMs),
    };
    panes.set(paneId, batch);
    return batch;
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

    if (batch.length === 0) {
      return;
    }
    if (batch.chunks.length === 1) {
      this.emit(deviceId, paneId, batch.chunks[0] as Uint8Array);
      return;
    }

    const data = new Uint8Array(batch.length);
    let offset = 0;
    for (const chunk of batch.chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    this.emit(deviceId, paneId, data);
  }
}
