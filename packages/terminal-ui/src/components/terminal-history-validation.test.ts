import { describe, expect, test } from 'bun:test';
import type {
  GatewayHistoryCursor,
  GatewayPaneHistoryPage,
  GatewayPaneScreenSnapshot,
} from '@tmex/ws-client';
import {
  type HistoryPageValidationContext,
  bytesEqual,
  validateHistoryPage,
} from './terminal-history-validation';

const PANE_EPOCH = new Uint8Array([7]);
const HISTORY_EPOCH = new Uint8Array([9]);

const snapshot: GatewayPaneScreenSnapshot = {
  deviceId: 'device-1',
  paneId: '%1',
  paneEpoch: PANE_EPOCH,
  baseSeq: 0n,
  rows: 24,
  cols: 80,
  modes: 0,
  data: new Uint8Array(),
  historyCursor: null,
};

const cursor: GatewayHistoryCursor = {
  paneEpoch: PANE_EPOCH,
  historyEpoch: HISTORY_EPOCH,
  beforeLine: 10,
};

const nextCursor: GatewayHistoryCursor = {
  paneEpoch: PANE_EPOCH,
  historyEpoch: HISTORY_EPOCH,
  beforeLine: 6,
};

const page: GatewayPaneHistoryPage = {
  deviceId: 'device-1',
  paneId: '%1',
  paneEpoch: PANE_EPOCH,
  historyEpoch: HISTORY_EPOCH,
  lineStart: 6,
  lineEnd: 10,
  truncated: false,
  data: new Uint8Array(16),
  nextCursor,
};

const context: HistoryPageValidationContext = {
  snapshot,
  cursor,
  pageCount: 0,
  historyBytes: 0,
  maxHistoryPages: 64,
  maxHistoryBytes: 1024,
};

function validate(
  pageOverrides: Partial<GatewayPaneHistoryPage> = {},
  contextOverrides: Partial<HistoryPageValidationContext> = {}
) {
  return validateHistoryPage({ ...page, ...pageOverrides }, { ...context, ...contextOverrides });
}

describe('bytesEqual', () => {
  test('compares length and content', () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    expect(bytesEqual(new Uint8Array(), new Uint8Array())).toBe(true);
  });
});

describe('validateHistoryPage', () => {
  test('accepts a page that continues the cursor', () => {
    expect(validate()).toEqual({ ok: true });
  });

  test('accepts the last page, which carries no next cursor', () => {
    expect(validate({ lineStart: 0, nextCursor: null })).toEqual({ ok: true });
  });

  test('rejects a page from another device', () => {
    expect(validate({ deviceId: 'device-2' })).toEqual({
      ok: false,
      action: 'recover',
      reason: 'pane_mismatch',
    });
  });

  test('rejects a page from another pane', () => {
    expect(validate({ paneId: '%2' })).toEqual({
      ok: false,
      action: 'recover',
      reason: 'pane_mismatch',
    });
  });

  test('rejects a pane epoch that no longer matches the snapshot', () => {
    expect(validate({ paneEpoch: new Uint8Array([8]) })).toEqual({
      ok: false,
      action: 'recover',
      reason: 'pane_epoch_mismatch',
    });
  });

  test('rejects a pane epoch that matches the snapshot but not the cursor', () => {
    expect(validate({}, { cursor: { ...cursor, paneEpoch: new Uint8Array([8]) } })).toEqual({
      ok: false,
      action: 'recover',
      reason: 'cursor_pane_epoch_mismatch',
    });
  });

  test('rejects a history epoch that does not match the cursor', () => {
    expect(validate({ historyEpoch: new Uint8Array([10]) })).toEqual({
      ok: false,
      action: 'recover',
      reason: 'history_epoch_mismatch',
    });
  });

  test('rejects a page that does not end where the cursor starts', () => {
    expect(validate({ lineEnd: 11 })).toEqual({
      ok: false,
      action: 'recover',
      reason: 'line_end_mismatch',
    });
  });

  test('rejects an inverted line range', () => {
    expect(validate({ lineStart: 12, lineEnd: 10, nextCursor: null })).toEqual({
      ok: false,
      action: 'recover',
      reason: 'inverted_line_range',
    });
  });

  test('rejects a next cursor that does not chain from the page', () => {
    const mismatches: Array<Partial<GatewayHistoryCursor>> = [
      { paneEpoch: new Uint8Array([8]) },
      { historyEpoch: new Uint8Array([10]) },
      { beforeLine: 5 },
    ];
    for (const mismatch of mismatches) {
      expect(validate({ nextCursor: { ...nextCursor, ...mismatch } })).toEqual({
        ok: false,
        action: 'recover',
        reason: 'next_cursor_mismatch',
      });
    }
  });

  test('stops paging once the page budget is used up', () => {
    expect(validate({}, { pageCount: 64, maxHistoryPages: 64 })).toEqual({
      ok: false,
      action: 'stop_paging',
      reason: 'page_limit_reached',
    });
  });

  test('stops paging once the byte budget would be exceeded', () => {
    expect(validate({}, { historyBytes: 1020, maxHistoryBytes: 1024 })).toEqual({
      ok: false,
      action: 'stop_paging',
      reason: 'byte_limit_reached',
    });
    expect(validate({}, { historyBytes: 1008, maxHistoryBytes: 1024 })).toEqual({ ok: true });
  });

  test('结构性不一致优先于容量判定：断链必须走重取而非停止分页', () => {
    expect(validate({ lineEnd: 11 }, { pageCount: 64, maxHistoryPages: 64 })).toEqual({
      ok: false,
      action: 'recover',
      reason: 'line_end_mismatch',
    });
  });
});
