import { bytesEqual, bytesHex, copyBytes } from '../bytes';

export const DEFAULT_HISTORY_SESSION_TTL_MS = 60_000;
export const DEFAULT_MAX_HISTORY_SESSIONS = 32;

export interface PaneHistoryCursor {
  paneEpoch: Uint8Array;
  historyEpoch: Uint8Array;
  beforeLine: number;
}

export interface HistorySession {
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

export function isHistoryCursorEvicted(beforeLine: number, historySize: number): boolean {
  return beforeLine > historySize;
}

export function isHistoryCaptureLengthEvicted(actualRows: number, expectedRows: number): boolean {
  return actualRows !== expectedRows;
}

export class PaneHistorySessionStore {
  private readonly sessions = new Map<string, HistorySession>();
  private readonly now: () => number;
  private readonly createEpoch: () => Uint8Array;
  private readonly sessionTtlMs: number;
  private readonly maxSessions: number;

  constructor(
    options: {
      now?: () => number;
      createEpoch?: () => Uint8Array;
      sessionTtlMs?: number;
      maxSessions?: number;
    } = {}
  ) {
    this.now = options.now ?? Date.now;
    this.createEpoch = options.createEpoch ?? randomEpoch;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_HISTORY_SESSION_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_HISTORY_SESSIONS;
  }

  currentTime(): number {
    return this.now();
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

  acquire(
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

  resolveCursor(paneId: string, paneEpoch: Uint8Array, cursor: PaneHistoryCursor): HistorySession {
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

  delete(session: HistorySession): void {
    this.sessions.delete(bytesHex(session.historyEpoch));
  }

  rejectIfEvicted(session: HistorySession, historySize: number): void {
    if (!isHistoryCursorEvicted(session.beforeLine, historySize)) return;
    this.delete(session);
    throw new PaneHistoryCursorError('cache_evicted', 'tmux history moved past this cursor');
  }

  rejectIfCaptureLengthMismatch(actualRows: number, expectedRows: number): void {
    if (!isHistoryCaptureLengthEvicted(actualRows, expectedRows)) return;
    throw new PaneHistoryCursorError(
      'cache_evicted',
      `tmux history range changed while reading: expected ${expectedRows} rows, got ${actualRows}`
    );
  }

  commitProgress(
    session: HistorySession,
    update: { lineStart: number; anchorHash: string; now: number }
  ): void {
    session.beforeLine = update.lineStart;
    session.anchorHash = update.anchorHash;
    session.expiresAt = update.now + this.sessionTtlMs;
    session.lastUsedAt = update.now;
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

  toCursor(session: HistorySession): PaneHistoryCursor {
    return {
      paneEpoch: copyBytes(session.paneEpoch),
      historyEpoch: copyBytes(session.historyEpoch),
      beforeLine: session.beforeLine,
    };
  }

  sweep(now: number): void {
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
