import { wsBorsh } from '@tmex/shared';

import type { PaneHistoryPage } from '../../tmux-client/pane-history-reader';
import type { PaneDataSegment, PaneScreenCheckpoint } from '../../tmux-client/pane-retention';
import { copyBytes, defaultCreateEpoch, paneKey } from './bytes';
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

export class CanonicalTransactionSender {
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
      const event =
        kind === 'screen'
          ? ({
              ScreenChunk: { requestId, offset, data: data.slice(offset, offset + maxDataBytes) },
            } satisfies CanonicalEvent)
          : ({
              HistoryChunk: { requestId, offset, data: data.slice(offset, offset + maxDataBytes) },
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
    const chunks = this.partitionMetadataRecords(snapshot, snapshotId);
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
    const chunks: wsBorsh.SourceMetadataRecord[][] = [];
    let current: wsBorsh.SourceMetadataRecord[] = [];
    for (const record of snapshot.records) {
      const candidate = [...current, record];
      const event: CanonicalEvent = {
        SourceMetadataSnapshot: {
          metadataEpoch: snapshot.metadataEpoch,
          revision: snapshot.revision,
          snapshotId,
          chunkIndex: 0xffff,
          totalChunks: 0xffff,
          records: candidate,
        },
      };
      if (this.options.sizer.eventFits(event)) {
        current = candidate;
        continue;
      }
      if (current.length === 0) {
        this.sendError(
          null,
          wsBorsh.ERROR_FRAME_TOO_LARGE,
          'metadata record exceeds frame limit',
          false
        );
        return null;
      }
      chunks.push(current);
      current = [record];
      const single = {
        SourceMetadataSnapshot: {
          metadataEpoch: snapshot.metadataEpoch,
          revision: snapshot.revision,
          snapshotId,
          chunkIndex: 0xffff,
          totalChunks: 0xffff,
          records: current,
        },
      } satisfies CanonicalEvent;
      if (!this.options.sizer.eventFits(single)) {
        this.sendError(
          null,
          wsBorsh.ERROR_FRAME_TOO_LARGE,
          'metadata record exceeds frame limit',
          false
        );
        return null;
      }
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }
}
