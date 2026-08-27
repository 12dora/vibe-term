import { bytesEqual, bytesHex, concatBytes, copyBytes, truncateUtf8Tail } from '../bytes';

export const DEFAULT_HISTORY_SESSION_TTL_MS = 60_000;
export const DEFAULT_MAX_HISTORY_SESSIONS = 32;
export const DEFAULT_MAX_HISTORY_PAGE_BYTES = 256 * 1024;
const MAX_CAPTURE_LINES = 512;
const CAPTURE_OUTPUT_OVERHEAD_BYTES = 64 * 1024;

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
    let session = cursor ? this.resolveCursor(paneId, paneEpoch, cursor) : null;
    if (!session) {
      const initial = this.createCursor(paneId, paneEpoch, info.historySize);
      if (!initial) {
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
      session = this.resolveCursor(paneId, paneEpoch, initial);
    }

    const beforeLine = session.beforeLine;
    if (beforeLine > info.historySize) {
      this.sessions.delete(bytesHex(session.historyEpoch));
      throw new PaneHistoryCursorError('cache_evicted', 'tmux history moved past this cursor');
    }
    if (beforeLine === 0) return this.emptyPage(session);

    const estimatedBytesPerLine = Math.max(16, Math.max(1, info.cols) * 4);
    const lineCount = Math.max(
      1,
      Math.min(MAX_CAPTURE_LINES, Math.floor(byteLimit / estimatedBytesPerLine))
    );
    const requestedStart = Math.max(0, beforeLine - lineCount);
    const includesAnchor = session.anchorHash !== null && beforeLine < info.historySize;
    const captureEnd = includesAnchor ? beforeLine : beforeLine - 1;
    const startCoordinate = requestedStart - info.historySize;
    const endCoordinate = captureEnd - info.historySize;
    const captureLimit = Math.min(
      this.maxPageBytes * 2 + CAPTURE_OUTPUT_OVERHEAD_BYTES,
      byteLimit * 2 + CAPTURE_OUTPUT_OVERHEAD_BYTES
    );
    const captured = await this.source.capturePaneHistoryRange(
      paneId,
      startCoordinate,
      endCoordinate,
      captureLimit
    );
    const rows = splitCapturedRows(captured);
    const expectedRows = captureEnd - requestedStart + 1;
    if (rows.length !== expectedRows) {
      throw new PaneHistoryCursorError(
        'cache_evicted',
        `tmux history range changed while reading: expected ${expectedRows} rows, got ${rows.length}`
      );
    }
    if (includesAnchor) {
      const boundary = rows.pop();
      if (boundary === undefined || (await hashRow(boundary)) !== session.anchorHash) {
        this.sessions.delete(bytesHex(session.historyEpoch));
        throw new PaneHistoryCursorError('cache_evicted', 'tmux history boundary changed');
      }
    }

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
    if (selectedRows === 0) {
      throw new PaneHistoryCursorError('resource_exhausted', 'history page made no progress');
    }

    const lineStart = beforeLine - selectedRows;
    const firstSelectedRow = rows[rows.length - selectedRows];
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
      truncated,
      data: concatBytes(...selected),
      nextCursor: lineStart > 0 ? this.toCursor(session) : null,
    };
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
