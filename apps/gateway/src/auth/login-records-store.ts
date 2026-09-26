import type {
  LoginRecord,
  LoginRecordClient,
  LoginRecordCursor,
  LoginRecordKind,
  LoginRecordMethod,
  LoginRecordOutcome,
  LoginRecordSecond,
  LoginRecordsPage,
} from '@vibeterm/shared';
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { getDb as getOrmDb } from '../db/client';
import { gatewayKv, loginRecords } from '../db/schema';
import type { AuthDb } from './types';

export const LOGIN_RECORD_ROW_CAP = 20_000;
export const LOGIN_RECORD_RETENTION_KV_KEY = 'login_records.retention_days';

const TEXT_MAX = 256;
const IP_MAX = 128;
const UA_MAX = 512;
const CODE_MAX = 64;

export type NewLoginRecord = Omit<LoginRecord, 'id' | 'at'> & { at?: number };

export type LoginRecordListQuery = {
  outcome: LoginRecordOutcome;
  kind: 'interactive' | 'all';
  limit: number;
  before?: LoginRecordCursor;
};

type LoginRow = typeof loginRecords.$inferSelect;

export class LoginRecordStore {
  private readonly rowCap: number;

  constructor(
    private readonly db: AuthDb = getOrmDb(),
    opts?: { rowCap?: number }
  ) {
    this.rowCap = opts?.rowCap ?? LOGIN_RECORD_ROW_CAP;
  }

  insert(input: NewLoginRecord): void {
    const row = normalize(input);
    this.db.insert(loginRecords).values(row).run();
    this.trim(row.outcome === 'failed' ? 'failed' : 'success');
  }

  list(query: LoginRecordListQuery): LoginRecordsPage {
    const rows = this.db
      .select()
      .from(loginRecords)
      .where(listWhere(query))
      .orderBy(desc(loginRecords.at), desc(loginRecords.id))
      .limit(query.limit + 1)
      .all();
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      records: page.map(toLoginRecord),
      nextBefore: rows.length > query.limit && last ? { at: last.at, id: last.id } : null,
    };
  }

  deleteAll(): number {
    const n = this.count('success') + this.count('failed');
    this.db.delete(loginRecords).run();
    return n;
  }

  purgeBefore(cutoff: number): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(loginRecords)
      .where(lt(loginRecords.at, cutoff))
      .get();
    this.db.delete(loginRecords).where(lt(loginRecords.at, cutoff)).run();
    return Number(row?.n ?? 0);
  }

  count(outcome: LoginRecordOutcome): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(loginRecords)
      .where(eq(loginRecords.outcome, outcome))
      .get();
    return Number(row?.n ?? 0);
  }

  getRetentionDays(): number | null {
    const row = this.db
      .select()
      .from(gatewayKv)
      .where(eq(gatewayKv.key, LOGIN_RECORD_RETENTION_KV_KEY))
      .get();
    return row ? Number(row.value) : null;
  }

  setRetentionDays(days: number): void {
    const value = String(days);
    const updatedAt = new Date().toISOString();
    this.db
      .insert(gatewayKv)
      .values({ key: LOGIN_RECORD_RETENTION_KV_KEY, value, updatedAt })
      .onConflictDoUpdate({
        target: gatewayKv.key,
        set: { value, updatedAt },
      })
      .run();
  }

  private trim(outcome: LoginRecordOutcome): void {
    const extra = this.count(outcome) - this.rowCap;
    if (extra <= 0) return;
    const old = this.db
      .select({ id: loginRecords.id })
      .from(loginRecords)
      .where(eq(loginRecords.outcome, outcome))
      .orderBy(asc(loginRecords.at), asc(loginRecords.id))
      .limit(extra)
      .all();
    if (old.length === 0) return;
    this.db
      .delete(loginRecords)
      .where(
        inArray(
          loginRecords.id,
          old.map((row) => row.id)
        )
      )
      .run();
  }
}

function listWhere(query: LoginRecordListQuery) {
  const filters = [eq(loginRecords.outcome, query.outcome)];
  if (query.outcome === 'success' && query.kind !== 'all') {
    filters.push(eq(loginRecords.kind, 'interactive'));
  }
  if (query.before) {
    const cursor = beforeCursor(query.before);
    if (cursor) filters.push(cursor);
  }
  return and(...filters);
}

function beforeCursor(cursor: LoginRecordCursor) {
  return or(
    lt(loginRecords.at, cursor.at),
    and(eq(loginRecords.at, cursor.at), lt(loginRecords.id, cursor.id))
  );
}

function normalize(input: NewLoginRecord): LoginRow {
  const outcome: LoginRecordOutcome = input.outcome === 'failed' ? 'failed' : 'success';
  return {
    id: crypto.randomUUID(),
    at: input.at ?? Date.now(),
    outcome,
    uid: clip(input.uid, TEXT_MAX),
    username: clip(input.username, TEXT_MAX),
    method: pickMethod(input.method),
    second: pickSecond(input.second),
    client: pickClient(input.client),
    kind: input.kind === 'background' ? 'background' : 'interactive',
    viaNodeId: clip(input.viaNodeId, TEXT_MAX),
    targetNodeId: clip(input.targetNodeId, TEXT_MAX),
    ip: clip(input.ip, IP_MAX),
    userAgent: clip(input.userAgent, UA_MAX),
    origin: clip(input.origin, UA_MAX),
    code: outcome === 'success' ? null : clip(input.code, CODE_MAX),
  };
}

function toLoginRecord(row: LoginRow): LoginRecord {
  return {
    id: row.id,
    at: row.at,
    outcome: row.outcome === 'failed' ? 'failed' : 'success',
    uid: row.uid,
    username: row.username,
    method: pickMethod(row.method),
    second: pickSecond(row.second),
    client: pickClient(row.client),
    kind: row.kind === 'background' ? 'background' : 'interactive',
    viaNodeId: row.viaNodeId,
    targetNodeId: row.targetNodeId,
    ip: row.ip,
    userAgent: row.userAgent,
    origin: row.origin,
    code: row.code,
  };
}

function pickMethod(value: string | null | undefined): LoginRecordMethod | null {
  if (value === 'root' || value === 'passkey') return value;
  return null;
}

function pickSecond(value: string | null | undefined): LoginRecordSecond | null {
  if (value === 'totp' || value === 'passkey' || value === 'waived' || value === 'none') {
    return value;
  }
  return null;
}

function pickClient(value: string | null | undefined): LoginRecordClient {
  if (value === 'web' || value === 'cli') return value;
  return 'unknown';
}

function clip(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}
