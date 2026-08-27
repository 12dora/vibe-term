import { describe, expect, test } from 'bun:test';

import { concatBytes, truncateUtf8Tail } from '../bytes';
import {
  buildHistoryRangeRequest,
  emptyHistoryPage,
  hashRow,
  selectLinesByByteLimit,
  validateHistoryAnchor,
} from './pane-history-page';

describe('validateHistoryAnchor', () => {
  test('returns all rows when the capture does not include an anchor', async () => {
    const rows = ['one', 'two', 'three'];
    const result = await validateHistoryAnchor(rows, false, 'deadbeef');
    expect(result).toEqual({ ok: true, contentRows: ['one', 'two', 'three'] });
  });

  test('drops the matching boundary row', async () => {
    const rows = ['one', 'two', 'anchor'];
    const result = await validateHistoryAnchor(rows, true, await hashRow('anchor'));
    expect(result).toEqual({ ok: true, contentRows: ['one', 'two'] });
  });

  test('rejects a mismatched or missing boundary', async () => {
    const rows = ['one', 'two', 'anchor'];
    expect(await validateHistoryAnchor(rows, true, await hashRow('other'))).toEqual({ ok: false });
    expect(await validateHistoryAnchor([], true, await hashRow('anchor'))).toEqual({ ok: false });
  });
});

describe('selectLinesByByteLimit', () => {
  test('includes a page that lands exactly on the byte limit', () => {
    const exact = selectLinesByByteLimit(['aa', 'bb'], 6);
    expect(new TextDecoder().decode(concatBytes(...exact.selected))).toBe('aa\nbb\n');
    expect(exact.selectedRows).toBe(2);
    expect(exact.truncated).toBe(false);

    const oneByteShort = selectLinesByByteLimit(['aa', 'bb'], 5);
    expect(new TextDecoder().decode(concatBytes(...oneByteShort.selected))).toBe('bb\n');
    expect(oneByteShort.selectedRows).toBe(1);
    expect(oneByteShort.truncated).toBe(false);
  });

  test('truncates a multi-byte line on a codepoint boundary', () => {
    const encoded = new TextEncoder().encode('你好\n');
    const exact = selectLinesByByteLimit(['你好'], encoded.byteLength);
    expect(exact.truncated).toBe(false);
    expect(exact.selected[0]?.byteLength).toBe(encoded.byteLength);

    const cut = selectLinesByByteLimit(['你好'], 4);
    expect(cut.truncated).toBe(true);
    expect(cut.selectedRows).toBe(1);
    expect(cut.selected[0]).toEqual(truncateUtf8Tail(encoded, 4));
  });

  test('returns an empty selection for an empty page', () => {
    const empty = selectLinesByByteLimit([], 16);
    expect(empty.selectedRows).toBe(0);
    expect(empty.selected).toEqual([]);
    expect(empty.truncated).toBe(false);

    const page = emptyHistoryPage('%1', new Uint8Array(16).fill(1));
    expect(page.lineStart).toBe(0);
    expect(page.lineEnd).toBe(0);
    expect(page.truncated).toBe(false);
    expect(page.data.byteLength).toBe(0);
    expect(page.nextCursor).toBeNull();
  });
});

describe('buildHistoryRangeRequest', () => {
  test('builds tmux coordinates for first and subsequent pages', () => {
    const first = buildHistoryRangeRequest({
      beforeLine: 5,
      historySize: 5,
      cols: 1,
      byteLimit: 32,
      maxPageBytes: 256 * 1024,
      hasAnchor: false,
    });
    expect(first.startCoordinate).toBe(-2);
    expect(first.endCoordinate).toBe(-1);
    expect(first.includesAnchor).toBe(false);
    expect(first.expectedRows).toBe(2);

    const second = buildHistoryRangeRequest({
      beforeLine: 3,
      historySize: 5,
      cols: 1,
      byteLimit: 32,
      maxPageBytes: 256 * 1024,
      hasAnchor: true,
    });
    expect(second.startCoordinate).toBe(-4);
    expect(second.endCoordinate).toBe(-2);
    expect(second.includesAnchor).toBe(true);
    expect(second.expectedRows).toBe(3);
  });
});
