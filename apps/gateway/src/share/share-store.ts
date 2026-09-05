import {
  SHARE_DEFAULT_SETTINGS,
  SHARE_LOG_PAGE_MAX_BYTES,
  SHARE_LOG_PAGE_MAX_ENTRIES,
  type ShareEndReason,
  type ShareLogEntry,
  type ShareLogKind,
  type ShareLogPage,
  type ShareSettings,
  type ShareState,
} from '@tmex/shared/share';
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type { AuthDb } from '../auth/types';
import { getDb as getOrmDb } from '../db/client';
import { shareAccessTokens, shareLogs, shareSettings, shares } from '../db/schema';
import { hashRelayPassword, verifyRelayPassword } from '../relay/relay-password';

export const SHARE_SETTINGS_ID = 1;

export type ShareRow = {
  id: string;
  name: string;
  deviceId: string;
  windowId: string;
  windowName: string;
  state: ShareState;
  endReason: ShareEndReason | null;
  origin: string;
  url: string;
  recordLog: boolean;
  logBytes: number;
  logTruncated: boolean;
  logSeq: number;
  logPurgedAt: number | null;
  createdAt: number;
  expiresAt: number | null;
  endedAt: number | null;
};

export type ShareInsert = ShareRow & { passwordHash: string };

export type ShareLogAppend = {
  at: number;
  kind: ShareLogKind;
  paneId: string;
  data: Uint8Array;
  cols?: number;
  rows?: number;
};

export type ShareLogAppendResult = { logBytes: number; logSeq: number; truncated: boolean };

export type ShareAccessRow = {
  id: string;
  shareId: string;
  createdAt: number;
  expiresAt: number;
};

export function hashSharePassword(password: string): Promise<string> {
  return hashRelayPassword(password);
}

export function verifySharePassword(stored: string, password: string): Promise<boolean> {
  return verifyRelayPassword(stored, password);
}

function toRow(row: typeof shares.$inferSelect): ShareRow {
  return {
    id: row.id,
    name: row.name,
    deviceId: row.deviceId,
    windowId: row.windowId,
    windowName: row.windowName,
    state: row.state === 'ended' ? 'ended' : 'active',
    endReason: (row.endReason as ShareEndReason | null) ?? null,
    origin: row.origin,
    url: row.url,
    recordLog: Boolean(row.recordLog),
    logBytes: row.logBytes,
    logTruncated: Boolean(row.logTruncated),
    logSeq: row.logSeq,
    logPurgedAt: row.logPurgedAt ?? null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt ?? null,
    endedAt: row.endedAt ?? null,
  };
}

function toBytes(value: Buffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

export class ShareStore {
  constructor(private readonly db: AuthDb = getOrmDb()) {}

  insert(record: ShareInsert): void {
    this.db
      .insert(shares)
      .values({
        ...record,
        endReason: record.endReason,
        expiresAt: record.expiresAt,
        endedAt: record.endedAt,
        logPurgedAt: record.logPurgedAt,
      })
      .run();
  }

  get(id: string): ShareRow | null {
    const row = this.db.select().from(shares).where(eq(shares.id, id)).get();
    return row ? toRow(row) : null;
  }

  passwordHash(id: string): string | null {
    const row = this.db
      .select({ passwordHash: shares.passwordHash })
      .from(shares)
      .where(eq(shares.id, id))
      .get();
    return row?.passwordHash ?? null;
  }

  list(filter?: { deviceId?: string; windowId?: string }): ShareRow[] {
    const conditions = [];
    if (filter?.deviceId) conditions.push(eq(shares.deviceId, filter.deviceId));
    if (filter?.windowId) conditions.push(eq(shares.windowId, filter.windowId));
    const query = this.db.select().from(shares).orderBy(desc(shares.createdAt));
    const rows = conditions.length ? query.where(and(...conditions)).all() : query.all();
    return rows.map(toRow);
  }

  listActive(): ShareRow[] {
    return this.db.select().from(shares).where(eq(shares.state, 'active')).all().map(toRow);
  }

  end(id: string, reason: ShareEndReason, at: number): ShareRow | null {
    this.db
      .update(shares)
      .set({ state: 'ended', endReason: reason, endedAt: at })
      .where(and(eq(shares.id, id), eq(shares.state, 'active')))
      .run();
    this.db.delete(shareAccessTokens).where(eq(shareAccessTokens.shareId, id)).run();
    return this.get(id);
  }

  remove(id: string): boolean {
    const existing = this.get(id);
    if (!existing || existing.state !== 'ended') return false;
    this.db.delete(shares).where(eq(shares.id, id)).run();
    return true;
  }

  appendLogEntries(
    shareId: string,
    entries: readonly ShareLogAppend[],
    maxBytes: number
  ): ShareLogAppendResult | null {
    if (entries.length === 0) return null;
    return this.db.transaction((tx) => {
      const current = tx
        .select({
          logSeq: shares.logSeq,
          logBytes: shares.logBytes,
          logTruncated: shares.logTruncated,
          recordLog: shares.recordLog,
        })
        .from(shares)
        .where(eq(shares.id, shareId))
        .get();
      if (!current || !current.recordLog || current.logTruncated) return null;
      let seq = current.logSeq;
      let bytes = current.logBytes;
      let truncated = false;
      const rows: Array<typeof shareLogs.$inferInsert> = [];
      for (const entry of entries) {
        if (bytes + entry.data.byteLength > maxBytes) {
          truncated = true;
          break;
        }
        seq += 1;
        bytes += entry.data.byteLength;
        rows.push({
          shareId,
          seq,
          at: entry.at,
          kind: entry.kind,
          paneId: entry.paneId,
          cols: entry.cols ?? null,
          rows: entry.rows ?? null,
          data: Buffer.from(entry.data),
        });
      }
      if (rows.length > 0) tx.insert(shareLogs).values(rows).run();
      tx.update(shares)
        .set({ logSeq: seq, logBytes: bytes, logTruncated: truncated })
        .where(eq(shares.id, shareId))
        .run();
      return { logSeq: seq, logBytes: bytes, truncated };
    });
  }

  readLog(shareId: string, options: { after?: number; limit?: number } = {}): ShareLogPage {
    const share = this.get(shareId);
    const after = Math.max(0, Math.floor(options.after ?? 0));
    const limit = Math.min(
      SHARE_LOG_PAGE_MAX_ENTRIES,
      Math.max(1, Math.floor(options.limit ?? SHARE_LOG_PAGE_MAX_ENTRIES))
    );
    const rows = this.db
      .select()
      .from(shareLogs)
      .where(and(eq(shareLogs.shareId, shareId), gt(shareLogs.seq, after)))
      .orderBy(asc(shareLogs.seq))
      .limit(limit + 1)
      .all();
    const entries: ShareLogEntry[] = [];
    let bytes = 0;
    let more = false;
    for (const row of rows) {
      const data = toBytes(row.data);
      if (
        entries.length >= limit ||
        (entries.length > 0 && bytes + data.byteLength > SHARE_LOG_PAGE_MAX_BYTES)
      ) {
        more = true;
        break;
      }
      bytes += data.byteLength;
      entries.push({
        seq: row.seq,
        at: row.at,
        kind: row.kind as ShareLogKind,
        paneId: row.paneId,
        data: Buffer.from(data).toString('base64'),
        ...(row.cols === null ? {} : { cols: row.cols }),
        ...(row.rows === null ? {} : { rows: row.rows }),
      });
    }
    const last = entries.at(-1);
    return {
      entries,
      nextAfter: more && last ? last.seq : null,
      total: this.countLog(shareId),
      truncated: share?.logTruncated ?? false,
    };
  }

  countLog(shareId: string): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(shareLogs)
      .where(eq(shareLogs.shareId, shareId))
      .get();
    return Number(row?.count ?? 0);
  }

  purgeLogsBefore(cutoff: number, now: number): number {
    const affected = this.db
      .selectDistinct({ shareId: shareLogs.shareId })
      .from(shareLogs)
      .where(lt(shareLogs.at, cutoff))
      .all();
    if (affected.length === 0) return 0;
    this.db.delete(shareLogs).where(lt(shareLogs.at, cutoff)).run();
    for (const row of affected) {
      this.db.update(shares).set({ logPurgedAt: now }).where(eq(shares.id, row.shareId)).run();
    }
    return affected.length;
  }

  createAccessToken(input: {
    id: string;
    shareId: string;
    tokenHash: string;
    clientIp: string | null;
    createdAt: number;
    expiresAt: number;
  }): void {
    this.db.insert(shareAccessTokens).values(input).run();
  }

  findAccessToken(tokenHash: string): ShareAccessRow | null {
    const row = this.db
      .select()
      .from(shareAccessTokens)
      .where(eq(shareAccessTokens.tokenHash, tokenHash))
      .get();
    if (!row) return null;
    return {
      id: row.id,
      shareId: row.shareId,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }

  renewAccessToken(id: string, expiresAt: number, lastSeenAt: number): void {
    this.db
      .update(shareAccessTokens)
      .set({ expiresAt, lastSeenAt })
      .where(eq(shareAccessTokens.id, id))
      .run();
  }

  deleteAccessToken(tokenHash: string): void {
    this.db.delete(shareAccessTokens).where(eq(shareAccessTokens.tokenHash, tokenHash)).run();
  }

  sweepAccessTokens(now: number): void {
    this.db.delete(shareAccessTokens).where(lt(shareAccessTokens.expiresAt, now)).run();
  }

  getSettings(): ShareSettings {
    const row = this.db
      .select()
      .from(shareSettings)
      .where(eq(shareSettings.id, SHARE_SETTINGS_ID))
      .get();
    if (!row) return { ...SHARE_DEFAULT_SETTINGS };
    return {
      recordLogs: Boolean(row.recordLogs),
      logRetentionDays: row.logRetentionDays,
      logMaxBytes: row.logMaxBytes,
      defaultOrigin: row.defaultOrigin ?? null,
    };
  }

  saveSettings(settings: ShareSettings, now: number): ShareSettings {
    this.db
      .insert(shareSettings)
      .values({ id: SHARE_SETTINGS_ID, ...settings, updatedAt: now })
      .onConflictDoUpdate({
        target: shareSettings.id,
        set: { ...settings, updatedAt: now },
      })
      .run();
    return settings;
  }
}
