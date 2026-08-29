import { bytesEqual } from '../../bytes';
import type { PaneHistoryCursor } from '../pane-history-reader';
import type { PaneIdentity, PaneScreenCheckpoint } from '../pane-retention';
import {
  type CanonicalFrameCaptureHost,
  buildCanonicalCheckpoint,
  captureFrame,
  estimateHistoryLines,
} from './canonical-screen-checkpoint';

export { concatBytes, truncateUtf8Tail } from '../../bytes';

export interface CanonicalScreenCaptureHost extends CanonicalFrameCaptureHost {
  getPaneIdentity(paneId: string): PaneIdentity | null;
  maxCheckpointBytesPerPane(): number;
  findProjectedPane(paneId: string): { width?: number; height?: number } | undefined;
  createHistoryCursor(
    paneId: string,
    paneEpoch: Uint8Array,
    beforeLine: number
  ): PaneHistoryCursor | null;
  storeScreenCheckpoint(checkpoint: PaneScreenCheckpoint): boolean;
  now?(): number;
}

export class CanonicalScreenCapture {
  private readonly inflight = new Map<string, Promise<PaneScreenCheckpoint | null>>();

  constructor(private readonly host: CanonicalScreenCaptureHost) {}

  capture(paneId: string, byteLimit: number): Promise<PaneScreenCheckpoint | null> {
    const existing = this.inflight.get(paneId);
    if (existing) return existing;
    const pending = this.captureInternal(paneId, byteLimit).finally(() => {
      if (this.inflight.get(paneId) === pending) this.inflight.delete(paneId);
    });
    this.inflight.set(paneId, pending);
    return pending;
  }

  private async captureInternal(
    paneId: string,
    byteLimit: number
  ): Promise<PaneScreenCheckpoint | null> {
    const identity = this.host.getPaneIdentity(paneId);
    if (!identity) return null;
    const maxBytes = Math.min(byteLimit, this.host.maxCheckpointBytesPerPane());
    if (maxBytes < 64) return null;
    const historyLines = estimateHistoryLines(this.host.findProjectedPane(paneId), maxBytes);
    const { frame, baseCursor } = await captureFrame(this.host, paneId, historyLines);
    const currentIdentity = this.host.getPaneIdentity(paneId);
    if (
      !baseCursor ||
      !currentIdentity ||
      !bytesEqual(identity.paneEpoch, currentIdentity.paneEpoch) ||
      !bytesEqual(baseCursor.paneEpoch, currentIdentity.paneEpoch)
    ) {
      return null;
    }
    const checkpoint = buildCanonicalCheckpoint({
      paneId,
      paneEpoch: currentIdentity.paneEpoch,
      frame,
      baseSeq: baseCursor.terminalSeq,
      maxBytes,
      historyLines,
      capturedAt: (this.host.now ?? Date.now)(),
      createHistoryCursor: (id, epoch, beforeLine) =>
        this.host.createHistoryCursor(id, epoch, beforeLine),
    });
    this.host.storeScreenCheckpoint(checkpoint);
    return checkpoint;
  }
}
