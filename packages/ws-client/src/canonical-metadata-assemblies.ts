import { wsBorsh } from '@tmex/shared';
import {
  MAX_METADATA_ASSEMBLIES,
  MAX_METADATA_BUFFERED_BYTES,
  MAX_METADATA_CHUNKS,
  METADATA_ASSEMBLY_TIMEOUT_MS,
  type MetadataSnapshotAssembly,
  type MetadataSnapshotEvent,
  bytesEqual,
  bytesKey,
  copyBytes,
  discardSupersededMetadataAssemblies,
} from './canonical-state-helpers';

export interface CompletedMetadataSnapshot {
  metadataEpoch: Uint8Array;
  revision: bigint;
  records: wsBorsh.SourceMetadataRecord[];
}

export interface CanonicalMetadataAssembliesOptions {
  maxBufferedBytes?: number;
  timeoutMs?: number;
  onGap(): void;
}

export class CanonicalMetadataAssemblies {
  private readonly assemblies = new Map<string, MetadataSnapshotAssembly>();
  private readonly maxBufferedBytes: number;
  private readonly timeoutMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: CanonicalMetadataAssembliesOptions) {
    this.maxBufferedBytes = Math.max(1, options.maxBufferedBytes ?? MAX_METADATA_BUFFERED_BYTES);
    this.timeoutMs = Math.max(1, options.timeoutMs ?? METADATA_ASSEMBLY_TIMEOUT_MS);
  }

  accept(event: MetadataSnapshotEvent): CompletedMetadataSnapshot | null {
    if (
      event.totalChunks === 0 ||
      event.totalChunks > MAX_METADATA_CHUNKS ||
      event.chunkIndex >= event.totalChunks
    ) {
      this.options.onGap();
      return null;
    }
    const key = bytesKey(event.snapshotId);
    let assembly = this.assemblies.get(key);
    if (!assembly) {
      if (this.assemblies.size >= MAX_METADATA_ASSEMBLIES) {
        this.clear();
        this.options.onGap();
        return null;
      }
      assembly = this.createAssembly(event);
      this.assemblies.set(key, assembly);
    } else if (!this.matches(assembly, event)) {
      this.delete(key);
      this.options.onGap();
      return null;
    }
    if (assembly.chunks[event.chunkIndex]) {
      this.delete(key);
      this.options.onGap();
      return null;
    }
    const chunkBytes = this.snapshotBytes(event);
    if (chunkBytes === null || this.bufferedBytes() + chunkBytes > this.maxBufferedBytes) {
      this.clear();
      this.options.onGap();
      return null;
    }
    for (const record of event.records) assembly.deviceIds.add(record.key.deviceId);
    assembly.chunks[event.chunkIndex] = event.records;
    assembly.receivedChunks += 1;
    assembly.bufferedBytes += chunkBytes;
    if (assembly.receivedChunks !== assembly.totalChunks) {
      this.scheduleTimeout();
      return null;
    }
    this.assemblies.delete(key);
    discardSupersededMetadataAssemblies(this.assemblies, assembly.deviceIds);
    this.scheduleTimeout();
    return {
      metadataEpoch: assembly.metadataEpoch,
      revision: assembly.revision,
      records: assembly.chunks.flatMap((chunk) => chunk ?? []),
    };
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.assemblies.clear();
  }

  private createAssembly(event: MetadataSnapshotEvent): MetadataSnapshotAssembly {
    return {
      metadataEpoch: copyBytes(event.metadataEpoch),
      revision: event.revision,
      totalChunks: event.totalChunks,
      chunks: new Array(event.totalChunks),
      receivedChunks: 0,
      bufferedBytes: 0,
      expiresAt: Date.now() + this.timeoutMs,
      deviceIds: new Set(),
    };
  }

  private matches(assembly: MetadataSnapshotAssembly, event: MetadataSnapshotEvent): boolean {
    return (
      bytesEqual(assembly.metadataEpoch, event.metadataEpoch) &&
      assembly.revision === event.revision &&
      assembly.totalChunks === event.totalChunks
    );
  }

  private snapshotBytes(event: MetadataSnapshotEvent): number | null {
    try {
      return wsBorsh.encodeCanonicalEventPayload({ SourceMetadataSnapshot: event }).byteLength;
    } catch {
      return null;
    }
  }

  private bufferedBytes(): number {
    let bytes = 0;
    for (const assembly of this.assemblies.values()) bytes += assembly.bufferedBytes;
    return bytes;
  }

  private delete(key: string): void {
    this.assemblies.delete(key);
    this.scheduleTimeout();
  }

  private scheduleTimeout(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    let expiresAt = Number.POSITIVE_INFINITY;
    for (const assembly of this.assemblies.values()) {
      expiresAt = Math.min(expiresAt, assembly.expiresAt);
    }
    if (!Number.isFinite(expiresAt)) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.clear();
        this.options.onGap();
      },
      Math.max(0, expiresAt - Date.now())
    );
  }
}
