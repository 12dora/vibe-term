import { bytesEqual, bytesHex, concatBytes, copyBytes } from '../bytes';
import {
  type HistoryRowSelection,
  computeHistoryCaptureWindow,
  selectHistoryRows,
} from './pane-history-pagination';

export const DEFAULT_HISTORY_SESSION_TTL_MS = 60_000;
export const DEFAULT_MAX_HISTORY_SESSIONS = 32;
export const DEFAULT_MAX_HISTORY_PAGE_BYTES = 256 * 1024;

export interface PaneHistoryCursor {
  paneEpoch: Uint8Array;
  historyEpoch: Uint8Array;
  beforeLine: number;
}

export interface PaneHistoryCaptureInfo {
  historySize: number;
  cols: number;
}

export interface PaneHistorySource {
  getPaneHistoryCaptureInfo(paneId: string): Promise<PaneHistoryCaptureInfo>;
  capturePaneHistoryRange(
    paneId: string,
    startLine: number,
    endLine: number,
    maxOutputBytes: number
  ): Promise<string>;
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

interface HistorySession {
  paneId: string;
  paneEpoch: Uint8Array;
  historyEpoch: Uint8Array;
  beforeLine: number;
  anchorHash: string | null;
  expiresAt: number;
  lastUsedAt: number;
}

export class PaneHistoryCursorError extends Error {
  constructor(
    readonly reason: 'epoch_changed' | 'cache_evicted' | 'resource_exhausted',
    message: string
  ) {
    super(message);
    this.name = 'PaneHistoryCursorError';
  }
}

function randomEpoch(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

function splitCapturedRows(value: string): string[] {
  if (value.length === 0) return [];
  const withoutFinalNewline = value.endsWith('\n') ? value.slice(0, -1) : value;
  return withoutFinalNewline.split('\n');
}

async function hashRow(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesHex(new Uint8Array(digest));
}

export class PaneHistoryReader {
  private readonly sessions = new Map<string, HistorySession>();
  private readonly now: () => number;
  private readonly createEpoch: () => Uint8Array;
  private readonly sessionTtlMs: number;
  private readonly maxSessions: number;
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
    this.now = options.now ?? Date.now;
    this.createEpoch = options.createEpoch ?? randomEpoch;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_HISTORY_SESSION_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_HISTORY_SESSIONS;
    this.maxPageBytes = options.maxPageBytes ?? DEFAULT_MAX_HISTORY_PAGE_BYTES;
  }

  createCursor(
    paneId: string,
    paneEpoch: Uint8Array,
    beforeLine: number
  ): PaneHistoryCursor | null {
    if (beforeLine <= 0) return null;
    const now = this.now();
    this.sweep(now);
    const historyEpoch = this.createEpoch();
    if (historyEpoch.byteLength !== 16) throw new Error('history epoch must be 16 bytes');
    const session: HistorySession = {
      paneId,
      paneEpoch: copyBytes(paneEpoch),
      historyEpoch: copyBytes(historyEpoch),
      beforeLine: Math.min(0xffff_ffff, Math.floor(beforeLine)),
      anchorHash: null,
      expiresAt: now + this.sessionTtlMs,
      lastUsedAt: now,
    };
    this.sessions.set(bytesHex(historyEpoch), session);
    this.enforceSessionLimit();
    return this.toCursor(session);
  }

  async readPage(
    paneId: string,
    paneEpoch: Uint8Array,
    cursor: PaneHistoryCursor | null,
    requestedByteLimit: number
  ): Promise<PaneHistoryPage> {
    const now = this.now();
    this.sweep(now);
    const byteLimit = Math.max(1, Math.min(Math.floor(requestedByteLimit), this.maxPageBytes));
    const info = await this.source.getPaneHistoryCaptureInfo(paneId);
    const session = this.bootstrapHistorySession(paneId, paneEpoch, cursor, info.historySize);
    if (!session) {
      return {
        paneId,
        paneEpoch: copyBytes(paneEpoch),
        historyEpoch: new Uint8Array(16),
        lineStart: 0,
        lineEnd: 0,
        truncated: false,
        data: new Uint8Array(),
        nextCursor: null,
      };
    }

    const beforeLine = session.beforeLine;
    if (beforeLine > info.historySize) {
      this.sessions.delete(bytesHex(session.historyEpoch));
      throw new PaneHistoryCursorError('cache_evicted', 'tmux history moved past this cursor');
    }
    if (beforeLine === 0) return this.emptyPage(session);

    const window = computeHistoryCaptureWindow({
      beforeLine,
      historySize: info.historySize,
      cols: info.cols,
      byteLimit,
      maxPageBytes: this.maxPageBytes,
      hasAnchor: session.anchorHash !== null,
    });
    const captured = await this.source.capturePaneHistoryRange(
      paneId,
      window.startCoordinate,
      window.endCoordinate,
      window.captureLimit
    );
    const rows = splitCapturedRows(captured);
    const expectedRows = window.captureEnd - window.requestedStart + 1;
    if (rows.length !== expectedRows) {
      throw new PaneHistoryCursorError(
        'cache_evicted',
        `tmux history range changed while reading: expected ${expectedRows} rows, got ${rows.length}`
      );
    }
    if (window.includesAnchor) {
      const boundary = rows.pop();
      if (boundary === undefined || (await hashRow(boundary)) !== session.anchorHash) {
        this.sessions.delete(bytesHex(session.historyEpoch));
        throw new PaneHistoryCursorError('cache_evicted', 'tmux history boundary changed');
      }
    }

    return this.commitHistoryPage(
      paneId,
      paneEpoch,
      session,
      rows,
      selectHistoryRows(rows, byteLimit),
      beforeLine,
      now
    );
  }

  invalidatePane(paneId: string, paneEpoch?: Uint8Array): void {
    for (const [key, session] of this.sessions) {
      if (session.paneId !== paneId) continue;
      if (paneEpoch && bytesEqual(session.paneEpoch, paneEpoch)) continue;
      this.sessions.delete(key);
    }
  }

  dispose(): void {
    this.sessions.clear();
  }

  private bootstrapHistorySession(
    paneId: string,
    paneEpoch: Uint8Array,
    cursor: PaneHistoryCursor | null,
    historySize: number
  ): HistorySession | null {
    if (cursor) return this.resolveCursor(paneId, paneEpoch, cursor);
    const initial = this.createCursor(paneId, paneEpoch, historySize);
    if (!initial) return null;
    return this.resolveCursor(paneId, paneEpoch, initial);
  }

  private async commitHistoryPage(
    paneId: string,
    paneEpoch: Uint8Array,
    session: HistorySession,
    rows: string[],
    packed: HistoryRowSelection,
    beforeLine: number,
    now: number
  ): Promise<PaneHistoryPage> {
    if (packed.selectedRows === 0) {
      throw new PaneHistoryCursorError('resource_exhausted', 'history page made no progress');
    }
    const lineStart = beforeLine - packed.selectedRows;
    const firstSelectedRow = rows[rows.length - packed.selectedRows];
    if (firstSelectedRow === undefined) {
      throw new PaneHistoryCursorError('cache_evicted', 'history page boundary disappeared');
    }
    session.beforeLine = lineStart;
    session.anchorHash = await hashRow(firstSelectedRow);
    session.expiresAt = now + this.sessionTtlMs;
    session.lastUsedAt = now;
    return {
      paneId,
      paneEpoch: copyBytes(paneEpoch),
      historyEpoch: copyBytes(session.historyEpoch),
      lineStart,
      lineEnd: beforeLine,
      truncated: packed.truncated,
      data: concatBytes(...packed.selected),
      nextCursor: lineStart > 0 ? this.toCursor(session) : null,
    };
  }

  private resolveCursor(
    paneId: string,
    paneEpoch: Uint8Array,
    cursor: PaneHistoryCursor
  ): HistorySession {
    const session = this.sessions.get(bytesHex(cursor.historyEpoch));
    if (!session) throw new PaneHistoryCursorError('cache_evicted', 'history cursor expired');
    if (
      session.paneId !== paneId ||
      !bytesEqual(session.paneEpoch, paneEpoch) ||
      !bytesEqual(cursor.paneEpoch, paneEpoch)
    ) {
      throw new PaneHistoryCursorError('epoch_changed', 'history cursor pane epoch changed');
    }
    if (cursor.beforeLine !== session.beforeLine) {
      throw new PaneHistoryCursorError('cache_evicted', 'history cursor is stale or out of order');
    }
    return session;
  }

  private emptyPage(session: HistorySession): PaneHistoryPage {
    return {
      paneId: session.paneId,
      paneEpoch: copyBytes(session.paneEpoch),
      historyEpoch: copyBytes(session.historyEpoch),
      lineStart: 0,
      lineEnd: 0,
      truncated: false,
      data: new Uint8Array(),
      nextCursor: null,
    };
  }

  private toCursor(session: HistorySession): PaneHistoryCursor {
    return {
      paneEpoch: copyBytes(session.paneEpoch),
      historyEpoch: copyBytes(session.historyEpoch),
      beforeLine: session.beforeLine,
    };
  }

  private sweep(now: number): void {
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
  }

  private enforceSessionLimit(): void {
    while (this.sessions.size > this.maxSessions) {
      let oldestKey: string | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [key, session] of this.sessions) {
        if (session.lastUsedAt < oldest) {
          oldest = session.lastUsedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      this.sessions.delete(oldestKey);
    }
  }
}
