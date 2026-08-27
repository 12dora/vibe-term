import { bytesHex, copyBytes, truncateUtf8Tail } from '../bytes';
import type { PaneHistoryCursor } from './pane-history-session';

export const DEFAULT_MAX_HISTORY_PAGE_BYTES = 256 * 1024;
const MAX_CAPTURE_LINES = 512;
const CAPTURE_OUTPUT_OVERHEAD_BYTES = 64 * 1024;

export interface PaneHistoryCaptureInfo {
  historySize: number;
  cols: number;
}

export interface PaneHistoryPage {
  paneId: string;
  paneEpoch: Uint8Array;
  historyEpoch: Uint8Array;
  lineStart: number;
  lineEnd: number;
  truncated: boolean;
  data: Uint8Array;
  nextCursor: PaneHistoryCursor | null;
}

export interface HistoryRangeRequestInput {
  beforeLine: number;
  historySize: number;
  cols: number;
  byteLimit: number;
  maxPageBytes: number;
  hasAnchor: boolean;
}

export interface HistoryRangeRequest {
  requestedStart: number;
  includesAnchor: boolean;
  captureEnd: number;
  startCoordinate: number;
  endCoordinate: number;
  captureLimit: number;
  expectedRows: number;
}

export type HistoryAnchorValidation = { ok: true; contentRows: string[] } | { ok: false };

export interface HistoryLineSelection {
  selected: Uint8Array[];
  selectedRows: number;
  truncated: boolean;
}

export function clampHistoryPageBytes(requestedByteLimit: number, maxPageBytes: number): number {
  return Math.max(1, Math.min(Math.floor(requestedByteLimit), maxPageBytes));
}

export function splitCapturedRows(value: string): string[] {
  if (value.length === 0) return [];
  const withoutFinalNewline = value.endsWith('\n') ? value.slice(0, -1) : value;
  return withoutFinalNewline.split('\n');
}

export async function hashRow(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesHex(new Uint8Array(digest));
}

export function buildHistoryRangeRequest(input: HistoryRangeRequestInput): HistoryRangeRequest {
  const estimatedBytesPerLine = Math.max(16, Math.max(1, input.cols) * 4);
  const lineCount = Math.max(
    1,
    Math.min(MAX_CAPTURE_LINES, Math.floor(input.byteLimit / estimatedBytesPerLine))
  );
  const requestedStart = Math.max(0, input.beforeLine - lineCount);
  const includesAnchor = input.hasAnchor && input.beforeLine < input.historySize;
  const captureEnd = includesAnchor ? input.beforeLine : input.beforeLine - 1;
  return {
    requestedStart,
    includesAnchor,
    captureEnd,
    startCoordinate: requestedStart - input.historySize,
    endCoordinate: captureEnd - input.historySize,
    captureLimit: Math.min(
      input.maxPageBytes * 2 + CAPTURE_OUTPUT_OVERHEAD_BYTES,
      input.byteLimit * 2 + CAPTURE_OUTPUT_OVERHEAD_BYTES
    ),
    expectedRows: captureEnd - requestedStart + 1,
  };
}

export async function validateHistoryAnchor(
  rows: readonly string[],
  includesAnchor: boolean,
  expectedHash: string | null
): Promise<HistoryAnchorValidation> {
  if (!includesAnchor) return { ok: true, contentRows: [...rows] };
  const boundary = rows[rows.length - 1];
  if (boundary === undefined || (await hashRow(boundary)) !== expectedHash) {
    return { ok: false };
  }
  return { ok: true, contentRows: rows.slice(0, -1) };
}

export function selectLinesByByteLimit(
  rows: readonly string[],
  byteLimit: number
): HistoryLineSelection {
  const encoder = new TextEncoder();
  const selected: Uint8Array[] = [];
  let selectedBytes = 0;
  let truncated = false;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row === undefined) continue;
    const encoded = encoder.encode(`${row}\n`);
    if (selectedBytes + encoded.byteLength <= byteLimit) {
      selected.unshift(encoded);
      selectedBytes += encoded.byteLength;
      continue;
    }
    if (selected.length === 0) {
      selected.unshift(truncateUtf8Tail(encoded, byteLimit));
      truncated = true;
    }
    break;
  }
  return { selected, selectedRows: selected.length, truncated };
}

export function emptyHistoryPage(
  paneId: string,
  paneEpoch: Uint8Array,
  historyEpoch: Uint8Array = new Uint8Array(16)
): PaneHistoryPage {
  return {
    paneId,
    paneEpoch: copyBytes(paneEpoch),
    historyEpoch: copyBytes(historyEpoch),
    lineStart: 0,
    lineEnd: 0,
    truncated: false,
    data: new Uint8Array(),
    nextCursor: null,
  };
}
