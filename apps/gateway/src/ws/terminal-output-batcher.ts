export const GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES = 64 * 1024;

interface PendingBatch {
  chunks: Uint8Array[];
  length: number;
}

type OutputSink = (deviceId: string, paneId: string, data: Uint8Array) => void;

export class TerminalOutputBatcher {
  private readonly pending = new Map<string, Map<string, PendingBatch>>();

  constructor(
    private readonly emit: OutputSink,
    private readonly maxBytes = GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
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

  discardDevice(deviceId: string): void {
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

    const batch: PendingBatch = { chunks: [], length: 0 };
    panes.set(paneId, batch);
    queueMicrotask(() => {
      this.flush(deviceId, paneId, batch);
    });
    return batch;
  }

  private flush(deviceId: string, paneId: string, batch: PendingBatch): void {
    const panes = this.pending.get(deviceId);
    if (panes?.get(paneId) !== batch) {
      return;
    }
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
