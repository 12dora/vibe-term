import { describe, expect, test } from 'bun:test';
import type {
  GatewayHistoryCursor,
  GatewayPaneHistoryPage,
  GatewayPaneScreenSnapshot,
} from '@tmex/ws-client';
import {
  type TerminalHistoryCache,
  commitHistoryPage,
  copyHistoryCursor,
  validateHistoryPage,
} from './terminal-history-page';

const PANE_EPOCH = Uint8Array.from([1, 2, 3]);
const HISTORY_EPOCH = Uint8Array.from([9, 9]);

function makeSnapshot(
  overrides: Partial<GatewayPaneScreenSnapshot> = {}
): GatewayPaneScreenSnapshot {
  return {
    deviceId: 'device-1',
    paneId: 'pane-1',
    paneEpoch: Uint8Array.from(PANE_EPOCH),
    baseSeq: 0n,
    rows: 24,
    cols: 80,
    modes: 0,
    data: Uint8Array.from([]),
    historyCursor: null,
    ...overrides,
  };
}

function makeCursor(overrides: Partial<GatewayHistoryCursor> = {}): GatewayHistoryCursor {
  return {
    paneEpoch: Uint8Array.from(PANE_EPOCH),
    historyEpoch: Uint8Array.from(HISTORY_EPOCH),
    beforeLine: 100,
    ...overrides,
  };
}

function makePage(overrides: Partial<GatewayPaneHistoryPage> = {}): GatewayPaneHistoryPage {
  return {
    deviceId: 'device-1',
    paneId: 'pane-1',
    paneEpoch: Uint8Array.from(PANE_EPOCH),
    historyEpoch: Uint8Array.from(HISTORY_EPOCH),
    lineStart: 80,
    lineEnd: 100,
    truncated: false,
    data: Uint8Array.from([1, 2, 3, 4]),
    nextCursor: {
      paneEpoch: Uint8Array.from(PANE_EPOCH),
      historyEpoch: Uint8Array.from(HISTORY_EPOCH),
      beforeLine: 80,
    },
    ...overrides,
  };
}

function makeCache(overrides: Partial<TerminalHistoryCache> = {}): TerminalHistoryCache {
  return { pages: [], bytes: 0, maxPages: 4, maxBytes: 1024, ...overrides };
}

describe('validateHistoryPage', () => {
  test('accepts a page continuing the current cursor', () => {
    expect(validateHistoryPage(makePage(), makeSnapshot(), makeCursor(), makeCache())).toEqual({
      status: 'accepted',
    });
  });

  test('accepts a page without a next cursor', () => {
    const page = makePage({ nextCursor: null });
    expect(validateHistoryPage(page, makeSnapshot(), makeCursor(), makeCache())).toEqual({
      status: 'accepted',
    });
  });

  const invalidCases: [string, GatewayPaneHistoryPage][] = [
    ['other device', makePage({ deviceId: 'device-2' })],
    ['other pane', makePage({ paneId: 'pane-2' })],
    ['other pane epoch', makePage({ paneEpoch: Uint8Array.from([7, 7, 7]) })],
    ['shorter pane epoch', makePage({ paneEpoch: Uint8Array.from([1, 2]) })],
    ['other history epoch', makePage({ historyEpoch: Uint8Array.from([8]) })],
    ['line end not matching the cursor', makePage({ lineEnd: 99 })],
    ['inverted line range', makePage({ lineStart: 120, lineEnd: 100 })],
    [
      'next cursor on another pane epoch',
      makePage({
        nextCursor: {
          paneEpoch: Uint8Array.from([4, 4, 4]),
          historyEpoch: Uint8Array.from(HISTORY_EPOCH),
          beforeLine: 80,
        },
      }),
    ],
    [
      'next cursor on another history epoch',
      makePage({
        nextCursor: {
          paneEpoch: Uint8Array.from(PANE_EPOCH),
          historyEpoch: Uint8Array.from([5]),
          beforeLine: 80,
        },
      }),
    ],
    [
      'next cursor not continuing at lineStart',
      makePage({
        nextCursor: {
          paneEpoch: Uint8Array.from(PANE_EPOCH),
          historyEpoch: Uint8Array.from(HISTORY_EPOCH),
          beforeLine: 79,
        },
      }),
    ],
  ];

  for (const [label, page] of invalidCases) {
    test(`asks for cache_evicted recovery: ${label}`, () => {
      expect(validateHistoryPage(page, makeSnapshot(), makeCursor(), makeCache())).toEqual({
        status: 'invalid',
        recoveryReason: 'cache_evicted',
      });
    });
  }

  test('reports a silent limit when the page budget is exhausted', () => {
    const cache = makeCache({ pages: [makePage(), makePage(), makePage(), makePage()] });
    expect(validateHistoryPage(makePage(), makeSnapshot(), makeCursor(), cache)).toEqual({
      status: 'limit',
    });
  });

  test('reports a silent limit when the byte budget would be exceeded', () => {
    const cache = makeCache({ bytes: 1021 });
    expect(validateHistoryPage(makePage(), makeSnapshot(), makeCursor(), cache)).toEqual({
      status: 'limit',
    });
  });

  test('allows a page landing exactly on the byte budget', () => {
    const cache = makeCache({ bytes: 1020 });
    expect(validateHistoryPage(makePage(), makeSnapshot(), makeCursor(), cache)).toEqual({
      status: 'accepted',
    });
  });

  test('prefers recovery over the limit when the page is also invalid', () => {
    const cache = makeCache({ bytes: 1024 });
    const page = makePage({ lineEnd: 99 });
    expect(validateHistoryPage(page, makeSnapshot(), makeCursor(), cache)).toEqual({
      status: 'invalid',
      recoveryReason: 'cache_evicted',
    });
  });
});

describe('commitHistoryPage', () => {
  test('owns the page bytes, keeps pages sorted and returns the next cursor', () => {
    const cache = makeCache({ pages: [makePage({ lineStart: 40, lineEnd: 60 })], bytes: 4 });
    const source = makePage();
    const next = commitHistoryPage(cache, source);

    expect(cache.pages.map((page) => page.lineStart)).toEqual([40, 80]);
    expect(cache.bytes).toBe(8);
    expect(next).toEqual({
      paneEpoch: Uint8Array.from(PANE_EPOCH),
      historyEpoch: Uint8Array.from(HISTORY_EPOCH),
      beforeLine: 80,
    });

    source.data[0] = 42;
    expect(cache.pages[1]?.data[0]).toBe(1);
    expect(next).not.toBe(source.nextCursor);
  });

  test('returns null when the page has no next cursor', () => {
    expect(commitHistoryPage(makeCache(), makePage({ nextCursor: null }))).toBeNull();
  });
});

describe('copyHistoryCursor', () => {
  test('detaches the cursor byte arrays', () => {
    const cursor = makeCursor();
    const copy = copyHistoryCursor(cursor);
    cursor.paneEpoch[0] = 99;
    expect(copy?.paneEpoch[0]).toBe(1);
    expect(copyHistoryCursor(null)).toBeNull();
  });
});
