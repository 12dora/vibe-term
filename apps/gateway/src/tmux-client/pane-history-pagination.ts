import { truncateUtf8Tail } from '../bytes';

export const MAX_CAPTURE_LINES = 512;
export const CAPTURE_OUTPUT_OVERHEAD_BYTES = 64 * 1024;

export interface HistoryCaptureWindowInput {
  beforeLine: number;
  historySize: number;
  cols: number;
  byteLimit: number;
  maxPageBytes: number;
  hasAnchor: boolean;
}

export interface HistoryCaptureWindow {
  requestedStart: number;
  includesAnchor: boolean;
  captureEnd: number;
  startCoordinate: number;
  endCoordinate: number;
  captureLimit: number;
}

export interface HistoryRowSelection {
  selected: Uint8Array[];
  selectedRows: number;
  truncated: boolean;
}

export function computeHistoryCaptureWindow(
  input: HistoryCaptureWindowInput
): HistoryCaptureWindow {
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
  };
}

export function selectHistoryRows(rows: string[], byteLimit: number): HistoryRowSelection {
  const encoder = new TextEncoder();
  const selected: Uint8Array[] = [];
  let selectedBytes = 0;
  let selectedRows = 0;
  let truncated = false;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row === undefined) continue;
    const encoded = encoder.encode(`${row}\n`);
    if (selectedBytes + encoded.byteLength <= byteLimit) {
      selected.unshift(encoded);
      selectedBytes += encoded.byteLength;
      selectedRows += 1;
      continue;
    }
    if (selectedRows === 0) {
      const tail = truncateUtf8Tail(encoded, byteLimit);
      selected.unshift(tail);
      selectedBytes = tail.byteLength;
      selectedRows = 1;
      truncated = true;
    }
    break;
  }
  return { selected, selectedRows, truncated };
}
