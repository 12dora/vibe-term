import type { RelayEnvelope, RelayKeylogMemberOp } from '@vibeterm/shared/relay';
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import type { AuthDb } from '../auth/types';
import { relayKeyLog } from '../db/schema';
import type { RelayKeyLogRow } from './types';

/**
 * 行元数据：`by` = 写入者 node_id（uplink 已认证链路 / HTTP 节点签名 / 根签名 admit 的节点），
 * `rv` = 本行带的成员记录经中继验过根签名时的操作（admit / revoke / rotate-root），`via` = 写入路径，
 * `an` = 根签名 admit 证书里被准入的 node_id。它们与信封同存于 `blob` 列：读取一律经
 * `parseRelayEnvelopeJson` 投影回信封，旧版本中继读到也只会忽略这些字段。
 */
export type RelayKeyLogAttribution = {
  appendedBy: string | null;
  /** 本行成员记录经根签名验过时的操作；未验证 / 无成员记录为 null。 */
  rootOp: RelayKeylogMemberOp | null;
  via: RelayKeyLogWritePath | null;
  /** 根签名 admit 准入的 node_id；其它行为 null。 */
  admittedNodeId: string | null;
};

export type RelayKeyLogWritePath = 'uplink' | 'http';

export type RelayKeyLogRowMeta = RelayKeyLogAttribution & { seq: bigint; createdAt: number };

const ROOT_OPS = new Set<string>(['admit', 'revoke', 'rotate-root']);
const WRITE_PATHS = new Set<string>(['uplink', 'http']);

function stringField(parsed: Record<string, unknown>, key: string): string | null {
  const value = parsed[key];
  return typeof value === 'string' ? value : null;
}

function readRowMeta(raw: string): RelayKeyLogAttribution {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rv = stringField(parsed, 'rv');
    const via = stringField(parsed, 'via');
    return {
      appendedBy: stringField(parsed, 'by'),
      rootOp: rv && ROOT_OPS.has(rv) ? (rv as RelayKeylogMemberOp) : null,
      via: via && WRITE_PATHS.has(via) ? (via as RelayKeyLogWritePath) : null,
      admittedNodeId: stringField(parsed, 'an'),
    };
  } catch {
    return { appendedBy: null, rootOp: null, via: null, admittedNodeId: null };
  }
}

const te = new TextEncoder();

export class RelayKeyLogStore {
  /** 每租户已存字节数（`blob` 列 UTF-8 长度）；首次按需从库里求和，之后随写入维护。 */
  private readonly byteTotals = new Map<string, number>();

  constructor(private readonly db: AuthDb) {}

  head(tenantId: string): bigint {
    const row = this.db
      .select()
      .from(relayKeyLog)
      .where(eq(relayKeyLog.tenantId, tenantId))
      .orderBy(desc(relayKeyLog.seq))
      .limit(1)
      .get();
    return row ? BigInt(row.seq) : 0n;
  }

  list(tenantId: string, fromSeq: bigint, limit: number): RelayKeyLogRow[] {
    return this.db
      .select()
      .from(relayKeyLog)
      .where(and(eq(relayKeyLog.tenantId, tenantId), gte(relayKeyLog.seq, Number(fromSeq))))
      .orderBy(asc(relayKeyLog.seq))
      .limit(limit)
      .all()
      .map((row) => ({ seq: BigInt(row.seq), blob: row.blobJson }));
  }

  listAll(tenantId: string): RelayKeyLogRow[] {
    return this.list(tenantId, 1n, Number.MAX_SAFE_INTEGER);
  }

  getMeta(tenantId: string, seq: bigint): RelayKeyLogRowMeta | null {
    const row = this.db
      .select()
      .from(relayKeyLog)
      .where(and(eq(relayKeyLog.tenantId, tenantId), eq(relayKeyLog.seq, Number(seq))))
      .get();
    if (!row) return null;
    return { seq: BigInt(row.seq), createdAt: row.createdAt, ...readRowMeta(row.blobJson) };
  }

  bytes(tenantId: string): number {
    const cached = this.byteTotals.get(tenantId);
    if (cached !== undefined) return cached;
    const row = this.db
      .select({
        total: sql<number>`coalesce(sum(length(cast(${relayKeyLog.blobJson} as blob))), 0)`,
      })
      .from(relayKeyLog)
      .where(eq(relayKeyLog.tenantId, tenantId))
      .get();
    const total = Number(row?.total ?? 0);
    this.byteTotals.set(tenantId, total);
    return total;
  }

  static storedJson(input: { envelope: RelayEnvelope } & Partial<RelayKeyLogAttribution>): string {
    return JSON.stringify({
      ...input.envelope,
      ...(input.appendedBy ? { by: input.appendedBy } : {}),
      ...(input.rootOp ? { rv: input.rootOp } : {}),
      ...(input.via ? { via: input.via } : {}),
      ...(input.admittedNodeId ? { an: input.admittedNodeId } : {}),
    });
  }

  static storedBytes(json: string): number {
    return te.encode(json).byteLength;
  }

  append(
    input: {
      tenantId: string;
      seq: bigint;
      envelope: RelayEnvelope;
      now: number;
    } & Partial<RelayKeyLogAttribution>
  ): void {
    const blobJson = RelayKeyLogStore.storedJson(input);
    const before = this.bytes(input.tenantId);
    this.db
      .insert(relayKeyLog)
      .values({
        tenantId: input.tenantId,
        seq: Number(input.seq),
        blobJson,
        createdAt: input.now,
      })
      .run();
    this.byteTotals.set(input.tenantId, before + RelayKeyLogStore.storedBytes(blobJson));
  }

  /** 事务回滚后调用：缓存可能记了没提交的增量。 */
  forgetBytes(tenantId: string): void {
    this.byteTotals.delete(tenantId);
  }

  deleteAll(tenantId: string): void {
    this.db.delete(relayKeyLog).where(eq(relayKeyLog.tenantId, tenantId)).run();
    this.byteTotals.delete(tenantId);
  }
}

export function parseRelayEnvelopeJson(raw: string): RelayEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (rec.v !== 1 || typeof rec.n !== 'string' || typeof rec.ct !== 'string') return null;
    const epoch = rec.epoch;
    if (epoch !== undefined && typeof epoch !== 'number') return null;
    return {
      v: 1,
      ...(epoch === undefined ? {} : { epoch }),
      n: rec.n,
      ct: rec.ct,
    };
  } catch {
    return null;
  }
}
