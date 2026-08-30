import { wsBorsh } from '@tmex/shared';

import type { PaneHistoryPage } from '../../tmux-client/pane-history-reader';
import type { PaneDataSegment, PaneScreenCheckpoint } from '../../tmux-client/pane-retention';
import { ENVELOPE_BYTES, bytesEqual, copyBytes, defaultCreateEpoch, paneKey } from './bytes';
import { canonicalEventPayloadBytes, sourceMetadataRecordBytes } from './encoded-size';
import type { CanonicalFrameSizer } from './frame-sizer';
import {
  type AttachedDevice,
  type CanonicalEvent,
  type CanonicalFeedRuntime,
  type CanonicalPaneTarget,
  type CanonicalSendResult,
  canonicalSendAccepted,
  canonicalSendContinue,
} from './types';

export interface CanonicalTransactionSenderOptions {
  sizer: CanonicalFrameSizer;
  sendEvent: (event: CanonicalEvent) => CanonicalSendResult;
  isClosed: () => boolean;
  getServerEpoch: (deviceId: string) => Uint8Array | null | undefined;
}

interface MetadataPartitionCache {
  epoch: Uint8Array;
  revision: bigint;
  maxFrameBytes: number;
  chunks: wsBorsh.SourceMetadataRecord[][];
}

export class CanonicalTransactionSender {
  private metadataPartitionCache: MetadataPartitionCache | null = null;

  constructor(private readonly options: CanonicalTransactionSenderOptions) {}

  get sizer(): CanonicalFrameSizer {
    return this.options.sizer;
  }

  send(event: CanonicalEvent): CanonicalSendResult {
    if (this.options.isClosed() || !this.options.sizer.eventFits(event)) return false;
    return this.options.sendEvent(event);
  }

  sendFitted(event: CanonicalEvent): CanonicalSendResult {
    if (this.options.isClosed()) return false;
    return this.options.sendEvent(event);
  }

  sendError(requestId: Uint8Array | null, code: number, message: string, retryable: boolean): void {
    this.send({
      Error: {
        requestId: requestId ? copyBytes(requestId) : null,
        code,
        message: message.slice(0, 512),
        retryable,
      },
    });
  }

  sendContentChunks(kind: 'screen' | 'history', requestId: Uint8Array, data: Uint8Array): boolean {
    const maxDataBytes = this.options.sizer.maxContentChunkBytes(kind, requestId);
    if (maxDataBytes <= 0) return false;
    for (let offset = 0; offset < data.byteLength; offset += maxDataBytes) {
      const chunk = data.subarray(offset, offset + maxDataBytes);
      const event =
        kind === 'screen'
          ? ({
              ScreenChunk: { requestId, offset, data: chunk },
            } satisfies CanonicalEvent)
          : ({
              HistoryChunk: { requestId, offset, data: chunk },
            } satisfies CanonicalEvent);
      if (!canonicalSendContinue(this.sendFitted(event))) return false;
    }
    return true;
  }

  sendScreenTransaction(
    deviceId: string,
    requestId: Uint8Array,
    checkpoint: PaneScreenCheckpoint,
    holdLive: {
      splitAtBase: (key: string, paneEpoch: Uint8Array, baseSeq: bigint) => PaneDataSegment | null;
      sendLive: (deviceId: string, segment: PaneDataSegment) => boolean;
    }
  ): boolean {
    const serverEpoch = this.options.getServerEpoch(deviceId);
    if (!serverEpoch) return false;
    const heldLive = holdLive.splitAtBase(
      paneKey(deviceId, checkpoint.paneId),
      checkpoint.paneEpoch,
      checkpoint.baseSeq
    );
    const begin: CanonicalEvent = {
      ScreenBegin: {
        requestId,
        pane: { deviceId, serverEpoch, paneId: checkpoint.paneId },
        paneEpoch: copyBytes(checkpoint.paneEpoch),
        baseSeq: checkpoint.baseSeq,
        rows: checkpoint.rows,
        cols: checkpoint.cols,
        modes: checkpoint.modes,
        totalBytes: checkpoint.data.byteLength,
      },
    };
    if (!canonicalSendContinue(this.send(begin))) return false;
    if (!this.sendContentChunks('screen', requestId, checkpoint.data)) return false;
    const committed = this.send({
      ScreenCommit: {
        requestId,
        totalBytes: checkpoint.data.byteLength,
        historyCursor: checkpoint.historyCursor,
      },
    });
    if (committed === true && heldLive) holdLive.sendLive(deviceId, heldLive);
    return canonicalSendAccepted(committed);
  }

  sendHistoryTransaction(
    target: CanonicalPaneTarget,
    requestId: Uint8Array,
    page: PaneHistoryPage,
    flushPane: (key: string) => void
  ): boolean {
    flushPane(paneKey(target.deviceId, target.paneId));
    if (
      !canonicalSendContinue(
        this.send({
          HistoryBegin: {
            requestId,
            pane: target,
            paneEpoch: page.paneEpoch,
            historyEpoch: page.historyEpoch,
            lineStart: page.lineStart,
            lineEnd: page.lineEnd,
            truncated: page.truncated,
            totalBytes: page.data.byteLength,
          },
        })
      )
    ) {
      return false;
    }
    if (!this.sendContentChunks('history', requestId, page.data)) return false;
    return canonicalSendAccepted(
      this.send({
        HistoryCommit: {
          requestId,
          totalBytes: page.data.byteLength,
          nextCursor: page.nextCursor,
        },
      })
    );
  }

  sendMetadataSnapshot(device: AttachedDevice): boolean {
    const snapshot = device.runtime.getMetadataSnapshot();
    const snapshotId = defaultCreateEpoch();
    const chunks = this.cachedOrPartitionMetadata(snapshot, snapshotId);
    if (!chunks) return false;
    let sent = true;
    for (let index = 0; index < chunks.length; index += 1) {
      const result = this.send({
        SourceMetadataSnapshot: {
          metadataEpoch: snapshot.metadataEpoch,
          revision: snapshot.revision,
          snapshotId,
          chunkIndex: index,
          totalChunks: chunks.length,
          records: chunks[index] ?? [],
        },
      });
      if (result === 'backpressured') {
        sent = index === chunks.length - 1;
        break;
      }
      if (!canonicalSendAccepted(result)) {
        sent = false;
        break;
      }
    }
    device.metadataNeedsRebase = !sent;
    return sent;
  }

  partitionMetadataRecords(
    snapshot: ReturnType<CanonicalFeedRuntime['getMetadataSnapshot']>,
    snapshotId: Uint8Array
  ): wsBorsh.SourceMetadataRecord[][] | null {
    if (snapshot.records.length === 0) return [[]];
    const budget = this.metadataRecordsBudget(snapshot, snapshotId);
    if (budget == null) return null;
    const chunks: wsBorsh.SourceMetadataRecord[][] = [];
    let current: wsBorsh.SourceMetadataRecord[] = [];
    let used = 0;
    for (const record of snapshot.records) {
      const size = sourceMetadataRecordBytes(record);
      if (size == null || size > budget) {
        this.sendMetadataRecordTooLarge();
        return null;
      }
      if (current.length > 0 && used + size > budget) {
        chunks.push(current);
        current = [];
        used = 0;
      }
      current.push(record);
      used += size;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  private cachedOrPartitionMetadata(
    snapshot: ReturnType<CanonicalFeedRuntime['getMetadataSnapshot']>,
    snapshotId: Uint8Array
  ): wsBorsh.SourceMetadataRecord[][] | null {
    const cached = this.metadataPartitionCache;
    const maxFrameBytes = this.options.sizer.maxFrameBytes;
    if (
      cached &&
      cached.revision === snapshot.revision &&
      cached.maxFrameBytes === maxFrameBytes &&
      bytesEqual(cached.epoch, snapshot.metadataEpoch)
    ) {
      return cached.chunks;
    }
    const chunks = this.partitionMetadataRecords(snapshot, snapshotId);
    this.metadataPartitionCache = chunks
      ? {
          epoch: copyBytes(snapshot.metadataEpoch),
          revision: snapshot.revision,
          maxFrameBytes,
          chunks,
        }
      : null;
    return chunks;
  }

  private metadataRecordsBudget(
    snapshot: ReturnType<CanonicalFeedRuntime['getMetadataSnapshot']>,
    snapshotId: Uint8Array
  ): number | null {
    const emptyPayload = canonicalEventPayloadBytes({
      SourceMetadataSnapshot: {
        metadataEpoch: snapshot.metadataEpoch,
        revision: snapshot.revision,
        snapshotId,
        chunkIndex: 0xffff,
        totalChunks: 0xffff,
        records: [],
      },
    });
    if (emptyPayload == null) return null;
    const maxPayload = Math.min(
      this.options.sizer.maxFrameBytes - ENVELOPE_BYTES,
      wsBorsh.CANONICAL_STATE_MAX_PAYLOAD_BYTES
    );
    return maxPayload - emptyPayload;
  }

  private sendMetadataRecordTooLarge(): void {
    this.sendError(
      null,
      wsBorsh.ERROR_FRAME_TOO_LARGE,
      'metadata record exceeds frame limit',
      false
    );
  }
}
