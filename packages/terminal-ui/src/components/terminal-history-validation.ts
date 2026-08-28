import type {
  GatewayHistoryCursor,
  GatewayPaneHistoryPage,
  GatewayPaneScreenSnapshot,
} from '@tmex/ws-client';

export type HistoryPageRejectionReason =
  | 'pane_mismatch'
  | 'pane_epoch_mismatch'
  | 'cursor_pane_epoch_mismatch'
  | 'history_epoch_mismatch'
  | 'line_end_mismatch'
  | 'inverted_line_range'
  | 'next_cursor_mismatch';

export type HistoryPageLimitReason = 'page_limit_reached' | 'byte_limit_reached';

export type HistoryPageValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly action: 'recover'; readonly reason: HistoryPageRejectionReason }
  | { readonly ok: false; readonly action: 'stop_paging'; readonly reason: HistoryPageLimitReason };

export interface HistoryPageValidationContext {
  readonly snapshot: GatewayPaneScreenSnapshot;
  readonly cursor: GatewayHistoryCursor;
  readonly pageCount: number;
  readonly historyBytes: number;
  readonly maxHistoryPages: number;
  readonly maxHistoryBytes: number;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function continuesFrom(next: GatewayHistoryCursor, page: GatewayPaneHistoryPage): boolean {
  return (
    bytesEqual(next.paneEpoch, page.paneEpoch) &&
    bytesEqual(next.historyEpoch, page.historyEpoch) &&
    next.beforeLine === page.lineStart
  );
}

function rejectionOf(
  page: GatewayPaneHistoryPage,
  { snapshot, cursor }: HistoryPageValidationContext
): HistoryPageRejectionReason | null {
  if (page.deviceId !== snapshot.deviceId || page.paneId !== snapshot.paneId)
    return 'pane_mismatch';
  if (!bytesEqual(page.paneEpoch, snapshot.paneEpoch)) return 'pane_epoch_mismatch';
  if (!bytesEqual(page.paneEpoch, cursor.paneEpoch)) return 'cursor_pane_epoch_mismatch';
  if (!bytesEqual(page.historyEpoch, cursor.historyEpoch)) return 'history_epoch_mismatch';
  if (page.lineEnd !== cursor.beforeLine) return 'line_end_mismatch';
  if (page.lineStart > page.lineEnd) return 'inverted_line_range';
  if (page.nextCursor && !continuesFrom(page.nextCursor, page)) return 'next_cursor_mismatch';
  return null;
}

function limitOf(
  page: GatewayPaneHistoryPage,
  context: HistoryPageValidationContext
): HistoryPageLimitReason | null {
  if (context.pageCount >= context.maxHistoryPages) return 'page_limit_reached';
  if (context.historyBytes + page.data.byteLength > context.maxHistoryBytes) {
    return 'byte_limit_reached';
  }
  return null;
}

/**
 * history 分页的准入判定：结构性不一致（epoch / 行号断链）要求重取首屏，
 * 容量到顶只是停止继续分页，两者绝不能混为一谈。
 */
export function validateHistoryPage(
  page: GatewayPaneHistoryPage,
  context: HistoryPageValidationContext
): HistoryPageValidation {
  const rejection = rejectionOf(page, context);
  if (rejection) return { ok: false, action: 'recover', reason: rejection };
  const limit = limitOf(page, context);
  if (limit) return { ok: false, action: 'stop_paging', reason: limit };
  return { ok: true };
}
