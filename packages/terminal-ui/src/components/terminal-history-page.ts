import type {
  GatewayHistoryCursor,
  GatewayPaneHistoryPage,
  GatewayPaneScreenSnapshot,
  GatewayRebaseReason,
} from '@tmex/ws-client';

export interface TerminalHistoryCache {
  pages: GatewayPaneHistoryPage[];
  bytes: number;
  readonly maxPages: number;
  readonly maxBytes: number;
}

export type HistoryPageDecision =
  | { status: 'invalid'; recoveryReason: GatewayRebaseReason }
  | { status: 'limit' }
  | { status: 'accepted' };

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function copyHistoryCursor(
  cursor: GatewayHistoryCursor | null
): GatewayHistoryCursor | null {
  return cursor
    ? {
        paneEpoch: Uint8Array.from(cursor.paneEpoch),
        historyEpoch: Uint8Array.from(cursor.historyEpoch),
        beforeLine: cursor.beforeLine,
      }
    : null;
}

function copyHistoryPage(page: GatewayPaneHistoryPage): GatewayPaneHistoryPage {
  return {
    ...page,
    requestId: page.requestId ? Uint8Array.from(page.requestId) : undefined,
    paneEpoch: Uint8Array.from(page.paneEpoch),
    historyEpoch: Uint8Array.from(page.historyEpoch),
    data: Uint8Array.from(page.data),
    nextCursor: copyHistoryCursor(page.nextCursor),
  };
}

function belongsToSnapshot(
  page: GatewayPaneHistoryPage,
  snapshot: GatewayPaneScreenSnapshot
): boolean {
  return (
    page.deviceId === snapshot.deviceId &&
    page.paneId === snapshot.paneId &&
    bytesEqual(page.paneEpoch, snapshot.paneEpoch)
  );
}

function continuesCursor(page: GatewayPaneHistoryPage, cursor: GatewayHistoryCursor): boolean {
  return (
    bytesEqual(page.paneEpoch, cursor.paneEpoch) &&
    bytesEqual(page.historyEpoch, cursor.historyEpoch) &&
    page.lineEnd === cursor.beforeLine &&
    page.lineStart <= page.lineEnd
  );
}

function hasConsistentNextCursor(page: GatewayPaneHistoryPage): boolean {
  const next = page.nextCursor;
  if (!next) return true;
  return (
    bytesEqual(next.paneEpoch, page.paneEpoch) &&
    bytesEqual(next.historyEpoch, page.historyEpoch) &&
    next.beforeLine === page.lineStart
  );
}

function exhaustsCache(cache: TerminalHistoryCache, page: GatewayPaneHistoryPage): boolean {
  return (
    cache.pages.length >= cache.maxPages || cache.bytes + page.data.byteLength > cache.maxBytes
  );
}

/**
 * 页面校验与缓存写入分离：校验只回答“接受 / 不合法 / 缓存到顶”，
 * 不合法必须走 rebase 恢复，缓存到顶只是静默停止继续回补历史。
 */
export function validateHistoryPage(
  page: GatewayPaneHistoryPage,
  snapshot: GatewayPaneScreenSnapshot,
  cursor: GatewayHistoryCursor,
  cache: TerminalHistoryCache
): HistoryPageDecision {
  if (!belongsToSnapshot(page, snapshot) || !continuesCursor(page, cursor)) {
    return { status: 'invalid', recoveryReason: 'cache_evicted' };
  }
  if (!hasConsistentNextCursor(page)) {
    return { status: 'invalid', recoveryReason: 'cache_evicted' };
  }
  if (exhaustsCache(cache, page)) {
    return { status: 'limit' };
  }
  return { status: 'accepted' };
}

export function commitHistoryPage(
  cache: TerminalHistoryCache,
  page: GatewayPaneHistoryPage
): GatewayHistoryCursor | null {
  const owned = copyHistoryPage(page);
  cache.pages.push(owned);
  cache.pages.sort((left, right) => left.lineStart - right.lineStart);
  cache.bytes += owned.data.byteLength;
  return copyHistoryCursor(owned.nextCursor);
}
