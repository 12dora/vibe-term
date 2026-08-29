import { describe, expect, test } from 'bun:test';

import { computeHistoryCaptureWindow, selectHistoryRows } from './pane-history-pagination';
import {
  DEFAULT_MAX_HISTORY_PAGE_BYTES,
  PaneHistoryCursorError,
  PaneHistoryReader,
  type PaneHistorySource,
} from './pane-history-reader';

const PANE_EPOCH = new Uint8Array(16).fill(1);

function createSource(initialRows: string[]) {
  let rows = [...initialRows];
  const captures: Array<[number, number, number]> = [];
  const source: PaneHistorySource = {
    async getPaneHistoryCaptureInfo() {
      return { historySize: rows.length, cols: 1 };
    },
    async capturePaneHistoryRange(_paneId, startLine, endLine, maxOutputBytes) {
      captures.push([startLine, endLine, maxOutputBytes]);
      const start = rows.length + startLine;
      const end = rows.length + endLine;
      return `${rows.slice(start, end + 1).join('\n')}\n`;
    },
  };
  return {
    source,
    captures,
    replaceRows(next: string[]) {
      rows = [...next];
    },
  };
}

describe('PaneHistoryReader', () => {
  test('pages backwards with bounded data and a stable boundary anchor', async () => {
    const fake = createSource(['zero', 'one', 'two', 'three', 'four']);
    const reader = new PaneHistoryReader(fake.source, {
      createEpoch: () => new Uint8Array(16).fill(2),
    });

    const first = await reader.readPage('%1', PANE_EPOCH, null, 32);
    expect(new TextDecoder().decode(first.data)).toBe('three\nfour\n');
    expect(first.lineStart).toBe(3);
    expect(first.lineEnd).toBe(5);
    expect(first.nextCursor?.beforeLine).toBe(3);

    const second = await reader.readPage('%1', PANE_EPOCH, first.nextCursor, 32);
    expect(new TextDecoder().decode(second.data)).toBe('one\ntwo\n');
    expect(second.lineStart).toBe(1);
    expect(second.lineEnd).toBe(3);
    expect(fake.captures[1]?.slice(0, 2)).toEqual([-4, -2]);
  });

  test('detects history eviction instead of returning a shifted page', async () => {
    const fake = createSource(['zero', 'one', 'two', 'three']);
    const reader = new PaneHistoryReader(fake.source, {
      createEpoch: () => new Uint8Array(16).fill(3),
    });
    const first = await reader.readPage('%1', PANE_EPOCH, null, 10);
    fake.replaceRows(['one', 'two', 'three', 'four']);
    await expect(reader.readPage('%1', PANE_EPOCH, first.nextCursor, 10)).rejects.toBeInstanceOf(
      PaneHistoryCursorError
    );
  });

  test('expires sessions and marks a single oversized row as truncated', async () => {
    let now = 0;
    const fake = createSource(['x'.repeat(100)]);
    const reader = new PaneHistoryReader(fake.source, {
      now: () => now,
      sessionTtlMs: 10,
      createEpoch: () => new Uint8Array(16).fill(4),
    });
    const page = await reader.readPage('%1', PANE_EPOCH, null, 8);
    expect(page.data.byteLength).toBeLessThanOrEqual(8);
    expect(page.truncated).toBe(true);
    const cursor = reader.createCursor('%1', PANE_EPOCH, 1);
    now = 11;
    await expect(reader.readPage('%1', PANE_EPOCH, cursor, 8)).rejects.toBeInstanceOf(
      PaneHistoryCursorError
    );
  });
});

describe('computeHistoryCaptureWindow', () => {
  test('computes a first-page window without an anchor row', () => {
    expect(
      computeHistoryCaptureWindow({
        beforeLine: 5,
        historySize: 5,
        cols: 1,
        byteLimit: 32,
        maxPageBytes: DEFAULT_MAX_HISTORY_PAGE_BYTES,
        hasAnchor: false,
      })
    ).toEqual({
      requestedStart: 3,
      includesAnchor: false,
      captureEnd: 4,
      startCoordinate: -2,
      endCoordinate: -1,
      captureLimit: 32 * 2 + 64 * 1024,
    });
  });

  test('extends the window by one row when a boundary anchor is present', () => {
    const window = computeHistoryCaptureWindow({
      beforeLine: 3,
      historySize: 5,
      cols: 1,
      byteLimit: 32,
      maxPageBytes: DEFAULT_MAX_HISTORY_PAGE_BYTES,
      hasAnchor: true,
    });
    expect(window.includesAnchor).toBe(true);
    expect(window.requestedStart).toBe(1);
    expect(window.captureEnd).toBe(3);
    expect(window.startCoordinate).toBe(-4);
    expect(window.endCoordinate).toBe(-2);
  });
});

describe('selectHistoryRows', () => {
  test('packs from the newest row and counts the trailing newline', () => {
    const packed = selectHistoryRows(['aaa', 'b'], 6);
    expect(new TextDecoder().decode(concatSelected(packed.selected))).toBe('aaa\nb\n');
    expect(packed.selectedRows).toBe(2);
    expect(packed.truncated).toBe(false);
  });

  test('keeps newer rows and stops before an older row that would exceed the budget', () => {
    const packed = selectHistoryRows(['aaa', 'b'], 3);
    expect(new TextDecoder().decode(concatSelected(packed.selected))).toBe('b\n');
    expect(packed.selectedRows).toBe(1);
    expect(packed.truncated).toBe(false);
  });

  test('truncates a single oversized row on a UTF-8 boundary', () => {
    const packed = selectHistoryRows(['éx'], 2);
    expect(packed.selectedRows).toBe(1);
    expect(packed.truncated).toBe(true);
    expect(packed.selected[0]?.byteLength).toBeLessThanOrEqual(2);
    expect(new TextDecoder().decode(packed.selected[0])).toBe('x\n');
  });
});

function concatSelected(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
