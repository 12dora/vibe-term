import type { RelayQuota } from '@tmex/shared/relay';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { toBuffer, toBytes } from '../auth/binary';
import type { AuthDb } from '../auth/types';
import { relayEnrollments, relayNodes, relayTenants } from '../db/schema';
import { parseRelayQuotaJson, serializeRelayQuota } from './relay-quota';
import type {
  RelayEnrollmentRecord,
  RelayNodeRecord,
  RelayNodeStatusValue,
  RelayTenantRecord,
} from './types';

type TenantRow = typeof relayTenants.$inferSelect;
type NodeRow = typeof relayNodes.$inferSelect;
type EnrollmentRow = typeof relayEnrollments.$inferSelect;

function toTenant(row: TenantRow): RelayTenantRecord {
  return {
    id: row.id,
    rootPublicKey: toBytes(row.rootPublicKey),
    rootEpoch: row.rootEpoch,
    tokenHash: row.tokenHash,
    tokenEpoch: row.tokenEpoch,
    quota: parseRelayQuotaJson(row.quotaJson),
    label: row.label,
    kicked: row.kicked,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    bytesIn: row.bytesIn,
    bytesOut: row.bytesOut,
    keyLogHeadSeq: BigInt(row.keyLogHeadSeq),
  };
}

function toNode(row: NodeRow): RelayNodeRecord {
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

function toEnrollment(row: EnrollmentRow): RelayEnrollmentRecord {
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

export class RelayTenantStore {
  constructor(private readonly db: AuthDb) {}

  get(tenantId: string): RelayTenantRecord | null {
    const row = this.db.select().from(relayTenants).where(eq(relayTenants.id, tenantId)).get();
    return row ? toTenant(row) : null;
  }

  getByRootPublicKey(rootPublicKey: Uint8Array): RelayTenantRecord | null {
    const row = this.db
      .select()
      .from(relayTenants)
      .where(eq(relayTenants.rootPublicKey, toBuffer(rootPublicKey)))
      .get();
    return row ? toTenant(row) : null;
  }

  list(): RelayTenantRecord[] {
    return this.db.select().from(relayTenants).all().map(toTenant);
  }

  count(): number {
    return this.db.select().from(relayTenants).all().length;
  }

  create(input: {
    id: string;
    rootPublicKey: Uint8Array;
    rootEpoch: number;
    tokenHash: string;
    tokenEpoch: number;
    now: number;
  }): RelayTenantRecord {
    this.db
      .insert(relayTenants)
      .values({
        id: input.id,
        rootPublicKey: toBuffer(input.rootPublicKey),
        rootEpoch: input.rootEpoch,
        tokenHash: input.tokenHash,
        tokenEpoch: input.tokenEpoch,
        quotaJson: null,
        label: null,
        kicked: false,
        createdAt: input.now,
        lastSeenAt: null,
        bytesIn: 0,
        bytesOut: 0,
        keyLogHeadSeq: 0,
      })
      .run();
    const created = this.get(input.id);
    if (!created) throw new Error('relay tenant insert failed');
    return created;
  }

  /** 重新 enroll：换令牌、清踢出标记、刷新根 epoch，tenant_id 不变。 */
  reissueToken(input: {
    tenantId: string;
    tokenHash: string;
    tokenEpoch: number;
    rootEpoch: number;
    now: number;
  }): void {
    this.db
      .update(relayTenants)
      .set({
        tokenHash: input.tokenHash,
        tokenEpoch: input.tokenEpoch,
        rootEpoch: input.rootEpoch,
        kicked: false,
        lastSeenAt: input.now,
      })
      .where(eq(relayTenants.id, input.tenantId))
      .run();
  }

  setKicked(tenantId: string, kicked: boolean): void {
    this.db.update(relayTenants).set({ kicked }).where(eq(relayTenants.id, tenantId)).run();
  }

  patch(
    tenantId: string,
    patch: { quota?: RelayQuota | null; label?: string | null }
  ): RelayTenantRecord | null {
    const values: Partial<TenantRow> = {};
    if (patch.quota !== undefined) {
      values.quotaJson = patch.quota === null ? null : serializeRelayQuota(patch.quota);
    }
    if (patch.label !== undefined) values.label = patch.label;
    if (Object.keys(values).length > 0) {
      this.db.update(relayTenants).set(values).where(eq(relayTenants.id, tenantId)).run();
    }
    return this.get(tenantId);
  }

  touch(tenantId: string, now: number): void {
    this.db
      .update(relayTenants)
      .set({ lastSeenAt: now })
      .where(eq(relayTenants.id, tenantId))
      .run();
  }

  addUsage(tenantId: string, bytesIn: number, bytesOut: number, now: number): void {
    if (bytesIn <= 0 && bytesOut <= 0) return;
    this.db
      .update(relayTenants)
      .set({
        bytesIn: sql`${relayTenants.bytesIn} + ${Math.round(bytesIn)}`,
        bytesOut: sql`${relayTenants.bytesOut} + ${Math.round(bytesOut)}`,
        lastSeenAt: now,
      })
      .where(eq(relayTenants.id, tenantId))
      .run();
  }

  setKeyLogHead(tenantId: string, seq: bigint): void {
    this.db
      .update(relayTenants)
      .set({ keyLogHeadSeq: Number(seq) })
      .where(eq(relayTenants.id, tenantId))
      .run();
  }

  remove(tenantId: string): void {
    this.db.delete(relayTenants).where(eq(relayTenants.id, tenantId)).run();
  }

  getNode(tenantId: string, nodeId: string): RelayNodeRecord | null {
    const row = this.db
      .select()
      .from(relayNodes)
      .where(and(eq(relayNodes.tenantId, tenantId), eq(relayNodes.nodeId, nodeId)))
      .get();
    return row ? toNode(row) : null;
  }

  listNodes(tenantId: string): RelayNodeRecord[] {
    return this.db
      .select()
      .from(relayNodes)
      .where(eq(relayNodes.tenantId, tenantId))
      .all()
      .map(toNode);
  }

  /** 计入配额的节点数：pending + admitted（revoked 不占位）。 */
  countActiveNodes(tenantId: string): number {
    return this.listNodes(tenantId).filter((node) => node.status !== 'revoked').length;
  }

  upsertNode(input: {
    tenantId: string;
    nodeId: string;
    edPk: Uint8Array;
    x25519Pk: Uint8Array;
    status: RelayNodeStatusValue;
    admitSeq?: number | null;
    now: number;
  }): RelayNodeRecord {
    this.db
      .insert(relayNodes)
      .values({
        tenantId: input.tenantId,
        nodeId: input.nodeId,
        edPk: toBuffer(input.edPk),
        x25519Pk: toBuffer(input.x25519Pk),
        status: input.status,
        admitSeq: input.admitSeq ?? null,
        lastSeenAt: null,
        protoVersion: null,
        clientVersion: null,
        createdAt: input.now,
      })
      .onConflictDoUpdate({
        target: [relayNodes.tenantId, relayNodes.nodeId],
        set: {
          edPk: toBuffer(input.edPk),
          x25519Pk: toBuffer(input.x25519Pk),
          status: input.status,
          ...(input.admitSeq === undefined ? {} : { admitSeq: input.admitSeq }),
        },
      })
      .run();
    const node = this.getNode(input.tenantId, input.nodeId);
    if (!node) throw new Error('relay node upsert failed');
    return node;
  }

  patchNode(
    tenantId: string,
    nodeId: string,
    patch: {
      status?: RelayNodeStatusValue;
      lastSeenAt?: number;
      protoVersion?: number;
      clientVersion?: string;
    }
  ): void {
    if (Object.keys(patch).length === 0) return;
    this.db
      .update(relayNodes)
      .set(patch)
      .where(and(eq(relayNodes.tenantId, tenantId), eq(relayNodes.nodeId, nodeId)))
      .run();
  }

  createEnrollment(input: {
    id: string;
    tenantId: string;
    enrollPk: Uint8Array;
    authorizationBytes: Uint8Array;
    authorizationSig: Uint8Array;
    expiresAt: number;
    now: number;
  }): RelayEnrollmentRecord {
    this.db
      .insert(relayEnrollments)
      .values({
        id: input.id,
        tenantId: input.tenantId,
        enrollPk: toBuffer(input.enrollPk),
        authorizationBytes: toBuffer(input.authorizationBytes),
        authorizationSig: toBuffer(input.authorizationSig),
        expiresAt: input.expiresAt,
        usedAt: null,
        nodeId: null,
        createdAt: input.now,
      })
      .run();
    const created = this.getEnrollmentById(input.id);
    if (!created) throw new Error('relay enrollment insert failed');
    return created;
  }

  getEnrollmentById(id: string): RelayEnrollmentRecord | null {
    const row = this.db.select().from(relayEnrollments).where(eq(relayEnrollments.id, id)).get();
    return row ? toEnrollment(row) : null;
  }

  getEnrollmentByEnrollPk(enrollPk: Uint8Array): RelayEnrollmentRecord | null {
    const row = this.db
      .select()
      .from(relayEnrollments)
      .where(eq(relayEnrollments.enrollPk, toBuffer(enrollPk)))
      .get();
    return row ? toEnrollment(row) : null;
  }

  consumeEnrollment(id: string, nodeId: string, now: number): boolean {
    const row = this.db
      .update(relayEnrollments)
      .set({ usedAt: now, nodeId })
      .where(and(eq(relayEnrollments.id, id), isNull(relayEnrollments.usedAt)))
      .returning()
      .get();
    return row !== undefined && row !== null;
  }
}
