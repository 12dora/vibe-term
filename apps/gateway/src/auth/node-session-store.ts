import { and, eq, isNull, lte, or } from 'drizzle-orm';
import { nodeSessions } from '../db/schema';
import { fromBase64Url, toBase64Url, toBuffer, toBytes } from './binary';
import type { AuthDb, DelegationMethod } from './types';

export const NODE_SESSION_TTL_MS = 18 * 60 * 60 * 1000;
export const NODE_SESSION_HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const NODE_SESSION_RENEW_THROTTLE_MS = 5 * 60 * 1000;

export type NodeSessionVerifyReason = 'unknown' | 'expired' | 'revoked' | 'via_mismatch';

export interface NodeSessionRecord {
  sid: string;
  userId: string;
  viaNodeId: string;
  sessPublicKey: Uint8Array;
  delegationMethod: DelegationMethod;
  credentialId: Uint8Array | null;
  issuedAt: number;
  expiresAt: number;
  hardExpiresAt: number;
  renewedAt: number;
  revokedAt: number | null;
}

export interface IssueNodeSessionInput {
  userId: string;
  viaNodeId: string;
  sessPublicKey: Uint8Array;
  delegationMethod: DelegationMethod;
  credentialId?: Uint8Array | null;
  now: number;
}

export type NodeSessionVerifyResult =
  | { ok: true; session: NodeSessionRecord; renewedExpiresAt?: number }
  | { ok: false; reason: NodeSessionVerifyReason };

export class NodeSessionStore {
  constructor(private readonly db: AuthDb) {}

  issue(input: IssueNodeSessionInput): {
    sid: string;
    expiresAt: number;
    hardExpiresAt: number;
  } {
    const sidBytes = crypto.getRandomValues(new Uint8Array(32));
    const expiresAt = input.now + NODE_SESSION_TTL_MS;
    const hardExpiresAt = input.now + NODE_SESSION_HARD_TTL_MS;
    this.db
      .insert(nodeSessions)
      .values({
        sid: toBuffer(sidBytes),
        userId: input.userId,
        viaNodeId: input.viaNodeId,
        sessPublicKey: toBuffer(input.sessPublicKey),
        delegationMethod: input.delegationMethod,
        credentialId: input.credentialId ? toBuffer(input.credentialId) : null,
        issuedAt: input.now,
        expiresAt,
        hardExpiresAt,
        renewedAt: input.now,
        revokedAt: null,
      })
      .run();
    return { sid: toBase64Url(sidBytes), expiresAt, hardExpiresAt };
  }

  verify(sid: string, input: { viaNodeId: string; now: number }): NodeSessionVerifyResult {
    const sidBytes = decodeSid(sid);
    if (!sidBytes) {
      return { ok: false, reason: 'unknown' };
    }

    return this.db.transaction((tx) => {
      const row = tx.select().from(nodeSessions).where(eq(nodeSessions.sid, sidBytes)).get();
      if (!row) {
        return { ok: false, reason: 'unknown' };
      }
      if (row.revokedAt != null) {
        return { ok: false, reason: 'revoked' };
      }
      if (row.viaNodeId !== input.viaNodeId) {
        return { ok: false, reason: 'via_mismatch' };
      }
      if (input.now >= row.expiresAt || input.now >= row.hardExpiresAt) {
        return { ok: false, reason: 'expired' };
      }

      let renewedExpiresAt: number | undefined;
      let expiresAt = row.expiresAt;
      let renewedAt = row.renewedAt;
      if (input.now - row.renewedAt > NODE_SESSION_RENEW_THROTTLE_MS) {
        expiresAt = Math.min(input.now + NODE_SESSION_TTL_MS, row.hardExpiresAt);
        renewedAt = input.now;
        renewedExpiresAt = expiresAt;
        tx.update(nodeSessions)
          .set({ expiresAt, renewedAt })
          .where(eq(nodeSessions.sid, sidBytes))
          .run();
      }

      return {
        ok: true as const,
        session: toRecord({ ...row, expiresAt, renewedAt }),
        ...(renewedExpiresAt !== undefined ? { renewedExpiresAt } : {}),
      };
    });
  }

  revoke(sid: string, now = Date.now()): void {
    const sidBytes = decodeSid(sid);
    if (!sidBytes) {
      return;
    }
    this.db
      .update(nodeSessions)
      .set({ revokedAt: now })
      .where(and(eq(nodeSessions.sid, sidBytes), isNull(nodeSessions.revokedAt)))
      .run();
  }

  revokeAllForUser(userId: string, now = Date.now()): void {
    this.db
      .update(nodeSessions)
      .set({ revokedAt: now })
      .where(and(eq(nodeSessions.userId, userId), isNull(nodeSessions.revokedAt)))
      .run();
  }

  revokeByCredential(credentialId: Uint8Array, now = Date.now()): void {
    this.db
      .update(nodeSessions)
      .set({ revokedAt: now })
      .where(
        and(eq(nodeSessions.credentialId, toBuffer(credentialId)), isNull(nodeSessions.revokedAt))
      )
      .run();
  }

  revokeVia(viaNodeId: string, now = Date.now()): void {
    this.db
      .update(nodeSessions)
      .set({ revokedAt: now })
      .where(and(eq(nodeSessions.viaNodeId, viaNodeId), isNull(nodeSessions.revokedAt)))
      .run();
  }

  sweepExpired(now: number): number {
    const where = or(lte(nodeSessions.expiresAt, now), lte(nodeSessions.hardExpiresAt, now));
    return this.db.delete(nodeSessions).where(where).returning({ sid: nodeSessions.sid }).all()
      .length;
  }
}

function decodeSid(sid: string): Buffer | null {
  const bytes = fromBase64Url(sid);
  if (bytes.byteLength !== 32) {
    return null;
  }
  return bytes;
}

function toRecord(row: typeof nodeSessions.$inferSelect): NodeSessionRecord {
  return {
    sid: toBase64Url(row.sid),
    userId: row.userId,
    viaNodeId: row.viaNodeId,
    sessPublicKey: toBytes(row.sessPublicKey),
    delegationMethod: row.delegationMethod as DelegationMethod,
    credentialId: row.credentialId ? toBytes(row.credentialId) : null,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    hardExpiresAt: row.hardExpiresAt,
    renewedAt: row.renewedAt,
    revokedAt: row.revokedAt,
  };
}
