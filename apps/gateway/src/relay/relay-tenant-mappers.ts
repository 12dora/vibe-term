import { toBytes } from '../auth/binary';
import type { relayEnrollments, relayNodes, relayTenants } from '../db/schema';
import { parseRelayQuotaJson } from './relay-quota';
import { RELAY_PREV_TOKEN_LIMIT, relayPreviousTokens } from './relay-token-grace';
import type {
  RelayEnrollmentRecord,
  RelayNodeRecord,
  RelayNodeStatusValue,
  RelayTenantRecord,
} from './types';

export type RelayTenantRow = typeof relayTenants.$inferSelect;
export type RelayNodeRow = typeof relayNodes.$inferSelect;
export type RelayEnrollmentRow = typeof relayEnrollments.$inferSelect;

export function readPreviousTokens(row: RelayTenantRow) {
  if (row.previousTokensJson == null) return relayPreviousTokens(row);
  try {
    const parsed: unknown = JSON.parse(row.previousTokensJson);
    if (!Array.isArray(parsed)) return [];
    const ring = parsed
      .filter(
        (entry) =>
          entry &&
          typeof entry.hash === 'string' &&
          typeof entry.issued_at === 'number' &&
          Number.isFinite(entry.issued_at)
      )
      .slice(0, RELAY_PREV_TOKEN_LIMIT)
      .map((entry) => ({
        hash: entry.hash as string,
        issued_at: entry.issued_at as number,
        ...(entry.node_only === true ? { node_only: true as const } : {}),
      }));
    const newest = ring[0];
    if (newest?.hash !== row.prevTokenHash || newest?.issued_at !== row.prevTokenIssuedAt) {
      return relayPreviousTokens(row);
    }
    return ring;
  } catch {
    return [];
  }
}

export function toTenant(row: RelayTenantRow): RelayTenantRecord {
  return {
    id: row.id,
    rootPublicKey: toBytes(row.rootPublicKey),
    rootEpoch: row.rootEpoch,
    tokenHash: row.tokenHash,
    tokenEpoch: row.tokenEpoch,
    prevTokenHash: row.prevTokenHash,
    prevTokenIssuedAt: row.prevTokenIssuedAt,
    previousTokens: readPreviousTokens(row),
    quota: parseRelayQuotaJson(row.quotaJson),
    label: row.label,
    kicked: row.kicked,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    bytesIn: row.bytesIn,
    bytesOut: row.bytesOut,
    keyLogHeadSeq: BigInt(row.keyLogHeadSeq),
    kdfParamsJson: row.kdfParamsJson,
    sealedPack: row.sealedPack ? toBytes(row.sealedPack) : null,
    sealedPackUpdatedAt: row.sealedPackUpdatedAt,
  };
}

export function toNode(row: RelayNodeRow): RelayNodeRecord {
  return {
    tenantId: row.tenantId,
    nodeId: row.nodeId,
    edPk: toBytes(row.edPk),
    x25519Pk: toBytes(row.x25519Pk),
    status: row.status as RelayNodeStatusValue,
    admitSeq: row.admitSeq,
    lastSeenAt: row.lastSeenAt,
    protoVersion: row.protoVersion,
    clientVersion: row.clientVersion,
    createdAt: row.createdAt,
  };
}

export function toEnrollment(row: RelayEnrollmentRow): RelayEnrollmentRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    enrollPk: toBytes(row.enrollPk),
    authorizationBytes: toBytes(row.authorizationBytes),
    authorizationSig: toBytes(row.authorizationSig),
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    nodeId: row.nodeId,
    createdAt: row.createdAt,
  };
}
