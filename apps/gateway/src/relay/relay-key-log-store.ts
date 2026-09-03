import type { RelayEnvelope } from '@tmex/shared/relay';
import { and, asc, desc, eq, gte } from 'drizzle-orm';
import type { AuthDb } from '../auth/types';
import { relayKeyLog } from '../db/schema';
import type { RelayKeyLogRow } from './types';

export class RelayKeyLogStore {
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
    return this.db
      .select()
      .from(relayKeyLog)
      .where(eq(relayKeyLog.tenantId, tenantId))
      .orderBy(asc(relayKeyLog.seq))
      .all()
      .map((row) => ({ seq: BigInt(row.seq), blob: row.blobJson }));
  }

  append(input: { tenantId: string; seq: bigint; envelope: RelayEnvelope; now: number }): void {
    this.db
      .insert(relayKeyLog)
      .values({
        tenantId: input.tenantId,
        seq: Number(input.seq),
        blobJson: JSON.stringify(input.envelope),
        createdAt: input.now,
      })
      .run();
  }

  deleteAll(tenantId: string): void {
    this.db.delete(relayKeyLog).where(eq(relayKeyLog.tenantId, tenantId)).run();
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
