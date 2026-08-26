import { PANE_MODE_ALT_SCREEN, PANE_MODE_FLAGS_PRESENT, encodePaneModes } from '@tmex/shared';

import type { PaneInfo } from '../capture-history';
import type { AtomicPaneCapture } from '../control-mode-capture';
import type { PaneHistoryCaptureInfo, PaneHistoryCursor } from '../pane-history-reader';
import type { PaneIdentity, PaneScreenCheckpoint, PaneTerminalCursor } from '../pane-retention';

export interface CanonicalScreenCaptureHost {
  getPaneIdentity(paneId: string): PaneIdentity | null;
  maxCheckpointBytesPerPane(): number;
  findProjectedPane(paneId: string): { width?: number; height?: number } | undefined;
  getLatestCursor(paneId: string): PaneTerminalCursor | null;
  capturePaneFrameAtBarrier?(
    paneId: string,
    historyLines: number,
    onBarrier: () => void
  ): Promise<AtomicPaneCapture>;
  getPaneInfo(paneId: string): Promise<PaneInfo>;
  capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string>;
  getPaneHistoryCaptureInfo(paneId: string): Promise<PaneHistoryCaptureInfo>;
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
    const estimatedCols = Math.max(1, projectedPane?.width ?? 80);
    const estimatedRows = Math.max(1, projectedPane?.height ?? 24);
    const estimatedBytesPerLine = Math.max(16, estimatedCols * 4);
    const boundedTotalLines = Math.max(
      estimatedRows,
      Math.min(estimatedRows + 256, Math.floor(maxBytes / estimatedBytesPerLine))
    );
    const historyLines = Math.max(0, boundedTotalLines - estimatedRows);
    let baseCursor: PaneTerminalCursor | null = null;
    let frame: AtomicPaneCapture;
    if (this.host.capturePaneFrameAtBarrier) {
      frame = await this.host.capturePaneFrameAtBarrier(paneId, historyLines, () => {
        baseCursor = this.host.getLatestCursor(paneId);
      });
    } else {
      const info = await this.host.getPaneInfo(paneId);
      const text = await this.host.capturePaneText(paneId, {
        historyLines: info.alternateScreen ? 0 : historyLines,
      });
      baseCursor = this.host.getLatestCursor(paneId);
      frame = {
        text,
        historyText: null,
        cols: info.cols,
        rows: info.rows,
        cursorX: info.cursorX,
        cursorY: info.cursorY,
        alternateScreen: info.alternateScreen,
        historySize: (await this.host.getPaneHistoryCaptureInfo(paneId)).historySize,
        modes: null,
      };
    }
    const prefix = frame.alternateScreen ? '\x1b[?1049h\x1b[2J\x1b[H' : '\x1b[2J\x1b[H';
    const cursor =
      frame.cursorX === null || frame.cursorY === null
        ? ''
        : `\x1b[${frame.cursorY + 1};${frame.cursorX + 1}H`;
    const encoder = new TextEncoder();
    const prefixBytes = encoder.encode(prefix);
    const cursorBytes = encoder.encode(cursor);
    const textBudget = Math.max(0, maxBytes - prefixBytes.byteLength - cursorBytes.byteLength);
    const visibleBytes = encoder.encode(frame.text);
    // alt 屏的 scrollback 属于 primary grid（TUI 启动前的旧 shell 输出），绝不拼进快照；
    // 预算不足时整段丢弃历史而不是从头部截断——截断会切断 SGR 序列且让行数失配。
    const includeHistory =
      !frame.alternateScreen && frame.historySize > 0 && frame.historyText !== null;
    const historyBytes = includeHistory
      ? encoder.encode(`${frame.historyText}\n`)
      : new Uint8Array(0);
    const historyIncluded =
      includeHistory && historyBytes.byteLength + visibleBytes.byteLength <= textBudget;
    const rawTextBytes = historyIncluded ? concatBytes(historyBytes, visibleBytes) : visibleBytes;
    // 降级路径（无 control 通道）的 text 本身就是 -S 合并采集，历史行内嵌其中
    const fallbackEmbeddedHistory = frame.historyText === null && !frame.alternateScreen;
    const embeddedHistoryLines = historyIncluded || fallbackEmbeddedHistory ? historyLines : 0;
    const textWasTruncated = rawTextBytes.byteLength > textBudget;
    const textBytes = truncateUtf8Tail(rawTextBytes, textBudget);
    const data = concatBytes(prefixBytes, textBytes, cursorBytes);
    const currentIdentity = this.host.getPaneIdentity(paneId);
    if (
      !baseCursor ||
      !currentIdentity ||
      !bytesEqual(identity.paneEpoch, currentIdentity.paneEpoch) ||
      !bytesEqual(baseCursor.paneEpoch, currentIdentity.paneEpoch)
    ) {
      return null;
    }
    const checkpoint: PaneScreenCheckpoint = {
      paneId,
      paneEpoch: currentIdentity.paneEpoch,
      baseSeq: baseCursor.terminalSeq,
      rows: Math.max(1, Math.min(frame.rows, 0xffff)),
      cols: Math.max(1, Math.min(frame.cols, 0xffff)),
      modes:
        (frame.alternateScreen ? PANE_MODE_ALT_SCREEN : 0) |
        (frame.modes ? encodePaneModes(frame.modes) | PANE_MODE_FLAGS_PRESENT : 0),
      data,
      historyCursor: frame.alternateScreen
        ? null
        : this.host.createHistoryCursor(
            paneId,
            currentIdentity.paneEpoch,
            textWasTruncated
              ? frame.historySize
              : Math.max(0, frame.historySize - embeddedHistoryLines)
          ),
      capturedAt: (this.host.now ?? Date.now)(),
    };
    this.host.storeScreenCheckpoint(checkpoint);
    return checkpoint;
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function truncateUtf8Tail(value: Uint8Array, byteLimit: number): Uint8Array {
  let start = Math.max(0, value.byteLength - byteLimit);
  while (start < value.byteLength && (value[start] ?? 0) >= 0x80 && (value[start] ?? 0) < 0xc0) {
    start += 1;
  }
  return value.slice(start);
}

export function concatBytes(...values: Uint8Array[]): Uint8Array {
  const total = values.reduce((sum, value) => sum + value.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}
