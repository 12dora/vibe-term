import { wsBorsh } from '@tmex/shared';

import {
  DEFAULT_FLUSH_INTERVAL_MS,
  MAX_PENDING_BYTES,
  type MetadataProjectionPatch,
  type MetadataProjectionSnapshot,
  type MetadataValue,
  type PendingUpsert,
  type ProjectedRecord,
  cloneKey,
  cloneValue,
  estimateKeyBytes,
  estimateUpsertBytes,
  keyId,
  upsertToWireRecord,
} from './types';

export interface MetadataPatchBufferOptions {
  flushIntervalMs?: number;
  maxPendingBytes?: number;
  getMetadataEpoch: () => Uint8Array;
  getRevision: () => bigint;
  currentSnapshot: () => MetadataProjectionSnapshot;
  onPatch?: (patch: MetadataProjectionPatch) => void;
  onRebaseRequired?: (snapshot: MetadataProjectionSnapshot) => void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export class MetadataPatchBuffer {
  private readonly dirtyUpserts = new Map<string, PendingUpsert>();
  private readonly dirtyRemovals = new Map<string, wsBorsh.SourceEntityKey>();
  private dirtyFromRevision: bigint | null = null;
  private dirtyBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushIntervalMs: number;
  private readonly maxPendingBytes: number;
  private readonly getMetadataEpoch: () => Uint8Array;
  private readonly getRevision: () => bigint;
  private readonly currentSnapshot: () => MetadataProjectionSnapshot;
  private readonly onPatch?: (patch: MetadataProjectionPatch) => void;
  private readonly onRebaseRequired?: (snapshot: MetadataProjectionSnapshot) => void;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  constructor(options: MetadataPatchBufferOptions) {
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxPendingBytes = options.maxPendingBytes ?? MAX_PENDING_BYTES;
    this.getMetadataEpoch = options.getMetadataEpoch;
    this.getRevision = options.getRevision;
    this.currentSnapshot = options.currentSnapshot;
    this.onPatch = options.onPatch;
    this.onRebaseRequired = options.onRebaseRequired;
    this.setTimeoutFn = options.setTimeout ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeout ?? clearTimeout;
  }

  beginDirtyRevision(currentRevision: bigint): void {
    if (this.dirtyFromRevision === null) this.dirtyFromRevision = currentRevision;
  }

  markFullUpsert(record: ProjectedRecord): void {
    const upsert: PendingUpsert = {
      key: cloneKey(record.key),
      parent: record.parent ? cloneKey(record.parent) : null,
      fields: new Map(
        Array.from(record.fields, ([field, state]) => [field, cloneValue(state.value)])
      ),
    };
    const id = keyId(record.key);
    this.dirtyRemovals.delete(id);
    this.dirtyUpserts.set(id, upsert);
    this.recalculateDirtyBytes();
  }

  markUpsert(record: ProjectedRecord, field?: number, value?: MetadataValue): void {
    const id = keyId(record.key);
    const upsert = this.dirtyUpserts.get(id) ?? {
      key: cloneKey(record.key),
      parent: record.parent ? cloneKey(record.parent) : null,
      fields: new Map<number, MetadataValue>(),
    };
    upsert.parent = record.parent ? cloneKey(record.parent) : null;
    if (field !== undefined && value) upsert.fields.set(field, cloneValue(value));
    this.dirtyRemovals.delete(id);
    this.dirtyUpserts.set(id, upsert);
    this.recalculateDirtyBytes();
  }

  markRemoval(key: wsBorsh.SourceEntityKey): void {
    const id = keyId(key);
    this.dirtyUpserts.delete(id);
    this.dirtyRemovals.set(id, cloneKey(key));
    this.recalculateDirtyBytes();
  }

  finishMutation(): void {
    if (this.dirtyBytes > this.maxPendingBytes) {
      this.clearPending();
      this.onRebaseRequired?.(this.currentSnapshot());
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = this.setTimeoutFn(() => this.flushPending(), this.flushIntervalMs);
    }
  }

  flushPending(): void {
    if (this.flushTimer) {
      this.clearTimeoutFn(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirtyFromRevision === null) return;

    const patch: MetadataProjectionPatch = {
      metadataEpoch: this.getMetadataEpoch(),
      fromRevision: this.dirtyFromRevision,
      throughRevision: this.getRevision(),
      upserts: Array.from(this.dirtyUpserts.values(), upsertToWireRecord),
      removals: Array.from(this.dirtyRemovals.values(), cloneKey),
    };
    this.clearPending();

    try {
      wsBorsh.encodeCanonicalEventPayload({ SourceMetadataPatch: patch });
    } catch (error) {
      if (error instanceof wsBorsh.WsBorshError && error.code === wsBorsh.ERROR_FRAME_TOO_LARGE) {
        this.onRebaseRequired?.(this.currentSnapshot());
        return;
      }
      throw error;
    }
    this.onPatch?.(patch);
  }

  clearPending(): void {
    if (this.flushTimer) this.clearTimeoutFn(this.flushTimer);
    this.flushTimer = null;
    this.dirtyUpserts.clear();
    this.dirtyRemovals.clear();
    this.dirtyFromRevision = null;
    this.dirtyBytes = 0;
  }

  dispose(): void {
    this.clearPending();
  }

  private recalculateDirtyBytes(): void {
    this.dirtyBytes = 0;
    for (const upsert of this.dirtyUpserts.values()) this.dirtyBytes += estimateUpsertBytes(upsert);
    for (const removal of this.dirtyRemovals.values()) this.dirtyBytes += estimateKeyBytes(removal);
  }
}
