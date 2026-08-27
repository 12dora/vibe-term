import type { AtomicPaneCapture } from '../control-mode-capture';
import type { PaneHistoryCursor } from '../pane-history-reader';
import type { PaneIdentity, PaneScreenCheckpoint } from '../pane-retention';
import {
  type ScreenPayload,
  assembleScreenPayload,
  buildScreenCheckpoint,
  concatBytes,
  estimateHistoryLines,
  historyCursorBeforeLine,
  resolveCaptureEpoch,
  truncateUtf8Tail,
} from './screen-checkpoint-builder';
import { type ScreenFrameCaptureHost, capturePaneFrame } from './screen-frame-source';

export { concatBytes, truncateUtf8Tail };

export interface CanonicalScreenCaptureHost extends ScreenFrameCaptureHost {
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
    const projectedPane = this.host.findProjectedPane(paneId);
    const historyLines = estimateHistoryLines({
      maxBytes,
      cols: projectedPane?.width,
      rows: projectedPane?.height,
    });
    const { frame, baseCursor } = await capturePaneFrame(this.host, paneId, historyLines);
    const payload = assembleScreenPayload(frame, { maxBytes, historyLines });
    const epoch = resolveCaptureEpoch(identity, this.host.getPaneIdentity(paneId), baseCursor);
    if (!epoch) return null;
    const checkpoint = buildScreenCheckpoint({
      paneId,
      paneEpoch: epoch.paneEpoch,
      baseSeq: epoch.baseSeq,
      frame,
      data: payload.data,
      historyCursor: checkpointHistoryCursor(this.host, paneId, epoch.paneEpoch, frame, payload),
      capturedAt: (this.host.now ?? Date.now)(),
    });
    this.host.storeScreenCheckpoint(checkpoint);
    return checkpoint;
  }
}

function checkpointHistoryCursor(
  host: CanonicalScreenCaptureHost,
  paneId: string,
  paneEpoch: Uint8Array,
  frame: AtomicPaneCapture,
  payload: ScreenPayload
): PaneHistoryCursor | null {
  if (frame.alternateScreen) return null;
  return host.createHistoryCursor(
    paneId,
    paneEpoch,
    historyCursorBeforeLine(
      frame.historySize,
      payload.embeddedHistoryLines,
      payload.textWasTruncated
    )
  );
}
