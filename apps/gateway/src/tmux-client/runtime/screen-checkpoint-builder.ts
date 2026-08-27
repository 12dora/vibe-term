import { PANE_MODE_ALT_SCREEN, PANE_MODE_FLAGS_PRESENT, encodePaneModes } from '@tmex/shared';

import { bytesEqual, concatBytes, truncateUtf8Tail } from '../../bytes';
import type { AtomicPaneCapture } from '../control-mode-capture';
import type { PaneHistoryCursor } from '../pane-history-reader';
import type { PaneIdentity, PaneScreenCheckpoint, PaneTerminalCursor } from '../pane-retention';

export { concatBytes, truncateUtf8Tail };

const DEFAULT_PANE_COLS = 80;
const DEFAULT_PANE_ROWS = 24;
const MIN_BYTES_PER_LINE = 16;
const MAX_HISTORY_LINE_SLACK = 256;
const MAX_PANE_DIMENSION = 0xffff;

export interface ScreenPayload {
  data: Uint8Array;
  textWasTruncated: boolean;
  embeddedHistoryLines: number;
}

export function estimateHistoryLines(input: {
  maxBytes: number;
  cols?: number;
  rows?: number;
}): number {
  const estimatedCols = Math.max(1, input.cols ?? DEFAULT_PANE_COLS);
  const estimatedRows = Math.max(1, input.rows ?? DEFAULT_PANE_ROWS);
  const estimatedBytesPerLine = Math.max(MIN_BYTES_PER_LINE, estimatedCols * 4);
  const boundedTotalLines = Math.max(
    estimatedRows,
    Math.min(
      estimatedRows + MAX_HISTORY_LINE_SLACK,
      Math.floor(input.maxBytes / estimatedBytesPerLine)
    )
  );
  return Math.max(0, boundedTotalLines - estimatedRows);
}

export function assembleScreenPayload(
  frame: AtomicPaneCapture,
  options: { maxBytes: number; historyLines: number }
): ScreenPayload {
  const encoder = new TextEncoder();
  const prefixBytes = encoder.encode(screenRestorePrefix(frame.alternateScreen));
  const cursorBytes = encoder.encode(screenCursorSequence(frame.cursorX, frame.cursorY));
  const textBudget = Math.max(
    0,
    options.maxBytes - prefixBytes.byteLength - cursorBytes.byteLength
  );
  const visibleBytes = encoder.encode(frame.text);
  const { rawTextBytes, historyIncluded } = selectTextBytes(
    frame,
    visibleBytes,
    textBudget,
    encoder
  );
  const textWasTruncated = rawTextBytes.byteLength > textBudget;
  return {
    data: concatBytes(prefixBytes, truncateUtf8Tail(rawTextBytes, textBudget), cursorBytes),
    textWasTruncated,
    embeddedHistoryLines: embeddedHistoryLineCount(frame, historyIncluded, options.historyLines),
  };
}

export function historyCursorBeforeLine(
  historySize: number,
  embeddedHistoryLines: number,
  textWasTruncated: boolean
): number {
  if (textWasTruncated) return historySize;
  return Math.max(0, historySize - embeddedHistoryLines);
}

export function encodeScreenModes(
  frame: Pick<AtomicPaneCapture, 'alternateScreen' | 'modes'>
): number {
  const alt = frame.alternateScreen ? PANE_MODE_ALT_SCREEN : 0;
  const flags = frame.modes ? encodePaneModes(frame.modes) | PANE_MODE_FLAGS_PRESENT : 0;
  return alt | flags;
}

export function resolveCaptureEpoch(
  identity: PaneIdentity,
  currentIdentity: PaneIdentity | null,
  baseCursor: PaneTerminalCursor | null
): { paneEpoch: Uint8Array; baseSeq: bigint } | null {
  if (
    !baseCursor ||
    !currentIdentity ||
    !bytesEqual(identity.paneEpoch, currentIdentity.paneEpoch) ||
    !bytesEqual(baseCursor.paneEpoch, currentIdentity.paneEpoch)
  ) {
    return null;
  }
  return { paneEpoch: currentIdentity.paneEpoch, baseSeq: baseCursor.terminalSeq };
}

export function buildScreenCheckpoint(input: {
  paneId: string;
  paneEpoch: Uint8Array;
  baseSeq: bigint;
  frame: AtomicPaneCapture;
  data: Uint8Array;
  historyCursor: PaneHistoryCursor | null;
  capturedAt: number;
}): PaneScreenCheckpoint {
  return {
    paneId: input.paneId,
    paneEpoch: input.paneEpoch,
    baseSeq: input.baseSeq,
    rows: clampPaneDimension(input.frame.rows),
    cols: clampPaneDimension(input.frame.cols),
    modes: encodeScreenModes(input.frame),
    data: input.data,
    historyCursor: input.historyCursor,
    capturedAt: input.capturedAt,
  };
}

function screenRestorePrefix(alternateScreen: boolean): string {
  return alternateScreen ? '\x1b[?1049h\x1b[2J\x1b[H' : '\x1b[2J\x1b[H';
}

function screenCursorSequence(cursorX: number | null, cursorY: number | null): string {
  if (cursorX === null || cursorY === null) return '';
  return `\x1b[${cursorY + 1};${cursorX + 1}H`;
}

function canAttachSeparateHistory(frame: AtomicPaneCapture): boolean {
  return !frame.alternateScreen && frame.historySize > 0 && frame.historyText !== null;
}

function selectTextBytes(
  frame: AtomicPaneCapture,
  visibleBytes: Uint8Array,
  textBudget: number,
  encoder: TextEncoder
): { rawTextBytes: Uint8Array; historyIncluded: boolean } {
  // alt 屏的 scrollback 属于 primary grid（TUI 启动前的旧 shell 输出），绝不拼进快照；
  // 预算不足时整段丢弃历史而不是从头部截断——截断会切断 SGR 序列且让行数失配。
  const historyText = canAttachSeparateHistory(frame) ? frame.historyText : null;
  if (historyText === null) {
    return { rawTextBytes: visibleBytes, historyIncluded: false };
  }
  const historyBytes = encoder.encode(`${historyText}\n`);
  const historyIncluded = historyBytes.byteLength + visibleBytes.byteLength <= textBudget;
  return {
    rawTextBytes: historyIncluded ? concatBytes(historyBytes, visibleBytes) : visibleBytes,
    historyIncluded,
  };
}

function embeddedHistoryLineCount(
  frame: AtomicPaneCapture,
  historyIncluded: boolean,
  historyLines: number
): number {
  // 降级路径（无 control 通道）的 text 本身就是 -S 合并采集，历史行内嵌其中
  const fallbackEmbeddedHistory = frame.historyText === null && !frame.alternateScreen;
  return historyIncluded || fallbackEmbeddedHistory ? historyLines : 0;
}

function clampPaneDimension(value: number): number {
  return Math.max(1, Math.min(value, MAX_PANE_DIMENSION));
}
