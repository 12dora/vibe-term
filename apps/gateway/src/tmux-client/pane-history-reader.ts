import { concatBytes, copyBytes } from '../bytes';
import {
  DEFAULT_MAX_HISTORY_PAGE_BYTES,
  type PaneHistoryCaptureInfo,
  type PaneHistoryPage,
  buildHistoryRangeRequest,
  clampHistoryPageBytes,
  emptyHistoryPage,
  hashRow,
  selectLinesByByteLimit,
  splitCapturedRows,
  validateHistoryAnchor,
} from './pane-history-page';
import {
  DEFAULT_HISTORY_SESSION_TTL_MS,
  DEFAULT_MAX_HISTORY_SESSIONS,
  type HistorySession,
  type PaneHistoryCursor,
  PaneHistoryCursorError,
  PaneHistorySessionStore,
} from './pane-history-session';

export {
  DEFAULT_HISTORY_SESSION_TTL_MS,
  DEFAULT_MAX_HISTORY_PAGE_BYTES,
  DEFAULT_MAX_HISTORY_SESSIONS,
  type PaneHistoryCaptureInfo,
  type PaneHistoryCursor,
  PaneHistoryCursorError,
  type PaneHistoryPage,
};

export interface PaneHistorySource {
  getPaneHistoryCaptureInfo(paneId: string): Promise<PaneHistoryCaptureInfo>;
  capturePaneHistoryRange(
    paneId: string,
    startLine: number,
    endLine: number,
    maxOutputBytes: number
  ): Promise<string>;
}

export class PaneHistoryReader {
  private readonly sessions: PaneHistorySessionStore;
  private readonly maxPageBytes: number;

  constructor(
    private readonly source: PaneHistorySource,
    options: {
      now?: () => number;
      createEpoch?: () => Uint8Array;
      sessionTtlMs?: number;
      maxSessions?: number;
      maxPageBytes?: number;
    } = {}
  ) {
    this.sessions = new PaneHistorySessionStore(options);
    this.maxPageBytes = options.maxPageBytes ?? DEFAULT_MAX_HISTORY_PAGE_BYTES;
  }

  createCursor(
    paneId: string,
    paneEpoch: Uint8Array,
    beforeLine: number
  ): PaneHistoryCursor | null {
    return this.sessions.createCursor(paneId, paneEpoch, beforeLine);
  }

  async readPage(
    paneId: string,
    paneEpoch: Uint8Array,
    cursor: PaneHistoryCursor | null,
    requestedByteLimit: number
  ): Promise<PaneHistoryPage> {
    const now = this.sessions.currentTime();
    this.sessions.sweep(now);
    const byteLimit = clampHistoryPageBytes(requestedByteLimit, this.maxPageBytes);
    const info = await this.source.getPaneHistoryCaptureInfo(paneId);
    const session = this.sessions.acquire(paneId, paneEpoch, cursor, info.historySize);
    if (!session) return emptyHistoryPage(paneId, paneEpoch);
    this.sessions.rejectIfEvicted(session, info.historySize);
    if (session.beforeLine === 0) {
      return emptyHistoryPage(session.paneId, session.paneEpoch, session.historyEpoch);
    }

    const range = buildHistoryRangeRequest({
      beforeLine: session.beforeLine,
      historySize: info.historySize,
      cols: info.cols,
      byteLimit,
      maxPageBytes: this.maxPageBytes,
      hasAnchor: session.anchorHash !== null,
    });
    const captured = await this.source.capturePaneHistoryRange(
      paneId,
      range.startCoordinate,
      range.endCoordinate,
      range.captureLimit
    );
    const rows = splitCapturedRows(captured);
    this.sessions.rejectIfCaptureLengthMismatch(rows.length, range.expectedRows);
    const content = await validateHistoryAnchor(rows, range.includesAnchor, session.anchorHash);
    if (!content.ok) {
      this.sessions.delete(session);
      throw new PaneHistoryCursorError('cache_evicted', 'tmux history boundary changed');
    }
    return this.assemblePage(paneId, paneEpoch, session, content.contentRows, byteLimit, now);
  }

  invalidatePane(paneId: string, paneEpoch?: Uint8Array): void {
    this.sessions.invalidatePane(paneId, paneEpoch);
  }

  dispose(): void {
    this.sessions.dispose();
  }

  private async assemblePage(
    paneId: string,
    paneEpoch: Uint8Array,
    session: HistorySession,
    rows: readonly string[],
    byteLimit: number,
    now: number
  ): Promise<PaneHistoryPage> {
    const beforeLine = session.beforeLine;
    const selection = selectLinesByByteLimit(rows, byteLimit);
    if (selection.selectedRows === 0) {
      throw new PaneHistoryCursorError('resource_exhausted', 'history page made no progress');
    }
    const lineStart = beforeLine - selection.selectedRows;
    const firstSelectedRow = rows[rows.length - selection.selectedRows];
    if (firstSelectedRow === undefined) {
      throw new PaneHistoryCursorError('cache_evicted', 'history page boundary disappeared');
    }
    this.sessions.commitProgress(session, {
      lineStart,
      anchorHash: await hashRow(firstSelectedRow),
      now,
    });
    return {
      paneId,
      paneEpoch: copyBytes(paneEpoch),
      historyEpoch: copyBytes(session.historyEpoch),
      lineStart,
      lineEnd: beforeLine,
      truncated: selection.truncated,
      data: concatBytes(...selection.selected),
      nextCursor: lineStart > 0 ? this.sessions.toCursor(session) : null,
    };
  }
}
