import { PANE_MODE_ALT_SCREEN, PANE_MODE_FLAGS_PRESENT, encodePaneModes } from '@tmex/shared';

import { concatBytes, truncateUtf8Tail } from '../../bytes';
import type { PaneInfo } from '../capture-history';
import type { AtomicPaneCapture } from '../control-mode-capture';
import type { PaneHistoryCaptureInfo, PaneHistoryCursor } from '../pane-history-reader';
import type { PaneScreenCheckpoint, PaneTerminalCursor } from '../pane-retention';

export interface CanonicalFrameCaptureHost {
  capturePaneFrameAtBarrier?(
    paneId: string,
    historyLines: number,
    onBarrier: () => void
  ): Promise<AtomicPaneCapture>;
  getLatestCursor(paneId: string): PaneTerminalCursor | null;
  getPaneInfo(paneId: string): Promise<PaneInfo>;
  capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string>;
  getPaneHistoryCaptureInfo(paneId: string): Promise<PaneHistoryCaptureInfo>;
}

export interface CapturedPaneFrame {
  frame: AtomicPaneCapture;
  baseCursor: PaneTerminalCursor | null;
}

export interface CanonicalCheckpointInput {
  paneId: string;
  paneEpoch: Uint8Array;
  frame: AtomicPaneCapture;
  baseSeq: bigint;
  maxBytes: number;
  historyLines: number;
  capturedAt: number;
  createHistoryCursor: (
    paneId: string,
    paneEpoch: Uint8Array,
    beforeLine: number
  ) => PaneHistoryCursor | null;
}

export function estimateHistoryLines(
  projectedPane: { width?: number; height?: number } | undefined,
  maxBytes: number
): number {
  const estimatedCols = Math.max(1, projectedPane?.width ?? 80);
  const estimatedRows = Math.max(1, projectedPane?.height ?? 24);
  const estimatedBytesPerLine = Math.max(16, estimatedCols * 4);
  const boundedTotalLines = Math.max(
    estimatedRows,
    Math.min(estimatedRows + 256, Math.floor(maxBytes / estimatedBytesPerLine))
  );
  return Math.max(0, boundedTotalLines - estimatedRows);
}

export async function captureFrame(
  host: CanonicalFrameCaptureHost,
  paneId: string,
  historyLines: number
): Promise<CapturedPaneFrame> {
  let baseCursor: PaneTerminalCursor | null = null;
  if (host.capturePaneFrameAtBarrier) {
    const frame = await host.capturePaneFrameAtBarrier(paneId, historyLines, () => {
      baseCursor = host.getLatestCursor(paneId);
    });
    return { frame, baseCursor };
  }
  const info = await host.getPaneInfo(paneId);
  const text = await host.capturePaneText(paneId, {
    historyLines: info.alternateScreen ? 0 : historyLines,
  });
  baseCursor = host.getLatestCursor(paneId);
  return {
    frame: {
      text,
      historyText: null,
      cols: info.cols,
      rows: info.rows,
      cursorX: info.cursorX,
      cursorY: info.cursorY,
      alternateScreen: info.alternateScreen,
      historySize: (await host.getPaneHistoryCaptureInfo(paneId)).historySize,
      modes: null,
    },
    baseCursor,
  };
}

export function buildCanonicalCheckpoint(input: CanonicalCheckpointInput): PaneScreenCheckpoint {
  const { paneId, paneEpoch, frame, baseSeq, maxBytes, historyLines, capturedAt } = input;
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
  return {
    paneId,
    paneEpoch,
    baseSeq,
    rows: Math.max(1, Math.min(frame.rows, 0xffff)),
    cols: Math.max(1, Math.min(frame.cols, 0xffff)),
    modes:
      (frame.alternateScreen ? PANE_MODE_ALT_SCREEN : 0) |
      (frame.modes ? encodePaneModes(frame.modes) | PANE_MODE_FLAGS_PRESENT : 0),
    data: concatBytes(prefixBytes, textBytes, cursorBytes),
    historyCursor: frame.alternateScreen
      ? null
      : input.createHistoryCursor(
          paneId,
          paneEpoch,
          textWasTruncated
            ? frame.historySize
            : Math.max(0, frame.historySize - embeddedHistoryLines)
        ),
    capturedAt,
  };
}
