import type { KeyLogHead, KeyLogType } from '@tmex/shared/auth';
import {
  decodeAddPasskeyPayload,
  decodeAdmitHubPayload,
  decodeAdmitNodePayload,
  decodeClearTotpPayload,
  decodeRemovePasskeyPayload,
  decodeRenameNodePayload,
  decodeResetRootPayload,
  decodeRetireHubPayload,
  decodeRevokeNodePayload,
  decodeRotateRootKeepPayload,
  decodeRotateRootPayload,
  decodeSetTotpPayload,
  encodeBase64url,
} from '@tmex/shared/auth';
import { and, asc, eq, gte } from 'drizzle-orm';
import { userKeyLog, users } from '../db/schema';
import { toBuffer, toBytes } from './binary';
import type { AuthDb } from './types';

export type KeyLogEntry = {
  bytes: Uint8Array;
  sig: Uint8Array;
  seq: number;
  hash: Uint8Array;
};

export type AppendKeyLogInput = {
  userId: string;
  seq: number;
  prevHash: Uint8Array;
  hash: Uint8Array;
  rootEpoch: number;
  type: string;
  recordBytes: Uint8Array;
  sig: Uint8Array;
  payloadJson: string;
  createdAt: number;
};

export class KeyLogStore {
  constructor(private readonly db: AuthDb) {}

  head(userId: string): KeyLogHead | null {
    const row = this.db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) {
      return null;
    }
    return { seq: BigInt(row.keyLogHeadSeq), hash: toBytes(row.keyLogHeadHash) };
  }

  list(userId: string, fromSeq?: number, limit?: number): KeyLogEntry[] {
    const base =
      fromSeq === undefined
        ? this.db
            .select()
            .from(userKeyLog)
            .where(eq(userKeyLog.userId, userId))
            .orderBy(asc(userKeyLog.seq))
        : this.db
            .select()
            .from(userKeyLog)
            .where(and(eq(userKeyLog.userId, userId), gte(userKeyLog.seq, fromSeq)))
            .orderBy(asc(userKeyLog.seq));
    const rows = limit != null ? base.limit(limit).all() : base.all();
    return rows.map(toEntry);
  }

  getAtSeq(userId: string, seq: number): KeyLogEntry | null {
    const row = this.db
      .select()
      .from(userKeyLog)
      .where(and(eq(userKeyLog.userId, userId), eq(userKeyLog.seq, seq)))
      .get();
    return row ? toEntry(row) : null;
  }

  append(input: AppendKeyLogInput): void {
    this.db
      .insert(userKeyLog)
      .values({
        seq: input.seq,
        userId: input.userId,
        prevHash: toBuffer(input.prevHash),
        hash: toBuffer(input.hash),
        rootEpoch: input.rootEpoch,
        type: input.type,
        recordBytes: toBuffer(input.recordBytes),
        sig: toBuffer(input.sig),
        payloadJson: input.payloadJson,
        createdAt: input.createdAt,
      })
      .run();
  }

  deleteAll(userId: string): void {
    this.db.delete(userKeyLog).where(eq(userKeyLog.userId, userId)).run();
  }
}

export function projectPayloadJson(type: string, payload: Uint8Array): string {
  try {
    return JSON.stringify(bytesToJson(decodePayload(type, payload)));
  } catch {
    return '{}';
  }
}

function decodePayload(type: string, payload: Uint8Array): unknown {
  switch (type as KeyLogType) {
    case 'add-passkey':
      return decodeAddPasskeyPayload(payload);
    case 'remove-passkey':
      return decodeRemovePasskeyPayload(payload);
    case 'rotate-root':
      return decodeRotateRootPayload(payload);
    case 'rotate-root-keep':
      return decodeRotateRootKeepPayload(payload);
    case 'reset-root':
      return decodeResetRootPayload(payload);
    case 'set-totp':
      return decodeSetTotpPayload(payload);
    case 'clear-totp':
      return decodeClearTotpPayload(payload);
    case 'admit-node':
    case 'readmit-node':
      return decodeAdmitNodePayload(payload);
    case 'revoke-node':
      return decodeRevokeNodePayload(payload);
    case 'admit-hub':
      return decodeAdmitHubPayload(payload);
    case 'retire-hub':
      return decodeRetireHubPayload(payload);
    case 'rename-node':
      return decodeRenameNodePayload(payload);
    default:
      return {};
  }
}

function bytesToJson(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return encodeBase64url(value);
  }
  if (Array.isArray(value)) {
    return value.map(bytesToJson);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = bytesToJson(nested);
    }
    return out;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return value;
}

function toEntry(row: typeof userKeyLog.$inferSelect): KeyLogEntry {
  return {
    bytes: toBytes(row.recordBytes),
    sig: toBytes(row.sig),
    seq: row.seq,
    hash: toBytes(row.hash),
  };
}
