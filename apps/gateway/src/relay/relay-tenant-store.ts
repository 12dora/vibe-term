import { bytesEqual } from '@vibeterm/shared/auth';
import type { RelayQuota } from '@vibeterm/shared/relay';
import { and, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { toBuffer } from '../auth/binary';
import type { AuthDb } from '../auth/types';
import { relayEnrollments, relayNodes, relayTenants } from '../db/schema';
import { serializeRelayQuota } from './relay-quota';
import { type RelayTenantRow, toEnrollment, toNode, toTenant } from './relay-tenant-mappers';
import {
  relayTokenHashAccepted,
  relayTokenHashState,
  relayTokensAfterReissue,
  relayTokensAfterRevoke,
} from './relay-token-grace';
import type {
  RelayEnrollmentRecord,
  RelayNodeRecord,
  RelayNodeStatusValue,
  RelayTenantRecord,
} from './types';

export type RelayNodeWriteOutcome = 'created' | 'unchanged' | 'promoted' | 'conflict' | 'revoked';

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
        prevTokenHash: null,
        prevTokenIssuedAt: null,
        previousTokensJson: '[]',
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

  /**
   * 重新 enroll：换令牌、清踢出标记，tenant_id 不变。
   * **不动 root_epoch**——它只由 `rotate-root` 侧带记录推进（enroll 里的 epoch 是未鉴权的自称值）。
   *
   * `keepPrevious` 时把旧哈希推入最多三代的历史环：成员节点要等新的 `set-relays` 才拿得到新令牌，
   * 宽限期内旧令牌仍可认证，它们才不会在拿到新记录之前先被踢下线。
   * 踢出恢复路径（`kicked` / epoch 过旧）传 false：那些链路本来就该断，旧令牌不留后门。
   */
  reissueToken(input: {
    tenantId: string;
    tokenHash: string;
    tokenEpoch: number;
    keepPrevious: boolean;
    now: number;
  }): void {
    const current = this.get(input.tenantId);
    const previousTokens =
      input.keepPrevious && current ? relayTokensAfterReissue(current, input.now) : [];
    this.db
      .update(relayTenants)
      .set({
        tokenHash: input.tokenHash,
        tokenEpoch: input.tokenEpoch,
        prevTokenHash: input.keepPrevious ? (current?.tokenHash ?? null) : null,
        prevTokenIssuedAt: input.keepPrevious ? input.now : null,
        previousTokensJson: JSON.stringify(previousTokens),
        kicked: false,
        lastSeenAt: input.now,
      })
      .where(eq(relayTenants.id, input.tenantId))
      .run();
  }

  /**
   * 根签名的 `revoke-node` 落库：吊销前签发的全部令牌（含当前）立刻对凭令牌的 HTTP 接口失效，
   * 只剩 uplink 宽限（uplink 另要已准入节点签名，被吊销节点用不了）；当前令牌仍是当前令牌，
   * 但下一次 enroll 必定换发，且不再给它 HTTP 宽限。
   */
  restrictTokensAfterRevoke(tenantId: string, now: number): void {
    const current = this.get(tenantId);
    if (!current) return;
    const ring = relayTokensAfterRevoke(current, now);
    this.db
      .update(relayTenants)
      .set({
        prevTokenHash: ring[0]?.hash ?? null,
        prevTokenIssuedAt: ring[0]?.issued_at ?? null,
        previousTokensJson: JSON.stringify(ring),
      })
      .where(eq(relayTenants.id, tenantId))
      .run();
  }

  /** 踢租户 / kick 模式改密：上一代令牌立刻失效，不留宽限。 */
  clearPreviousToken(tenantId: string): void {
    this.db
      .update(relayTenants)
      .set({ prevTokenHash: null, prevTokenIssuedAt: null, previousTokensJson: '[]' })
      .where(eq(relayTenants.id, tenantId))
      .run();
  }

  /**
   * 根轮换：只在旧根签名的 `rotate-root*` 记录验过之后调用。
   * `expectedRootEpoch` 是乐观并发条件——epoch 必须仍是验签时的那个，否则不写。
   */
  rotateRoot(input: {
    tenantId: string;
    expectedRootEpoch: number;
    rootPublicKey: Uint8Array;
    rootEpoch: number;
  }): boolean {
    if (input.rootEpoch <= input.expectedRootEpoch) return false;
    const row = this.db
      .update(relayTenants)
      .set({
        rootPublicKey: toBuffer(input.rootPublicKey),
        rootEpoch: input.rootEpoch,
        kdfParamsJson: null,
        sealedPack: null,
        sealedPackUpdatedAt: null,
      })
      .where(
        and(
          eq(relayTenants.id, input.tenantId),
          eq(relayTenants.rootEpoch, input.expectedRootEpoch)
        )
      )
      .returning()
      .get();
    return row !== undefined && row !== null;
  }

  /**
   * 写入密封包。`head_seq` 不得声称中继尚未持有的日志头；`root_epoch` 必须仍是验签时的那一代。
   */
  putPack(input: {
    tenantId: string;
    kdfParamsJson: string;
    sealedPack: Uint8Array;
    expectedRootEpoch: number;
    headSeq: bigint;
    tokenHash: string;
    minTokenEpoch: number;
    now: number;
  }):
    | 'ok'
    | 'not_found'
    | 'epoch'
    | 'head_ahead'
    | 'kicked'
    | 'unauthorized'
    | 'token_not_current' {
    let result:
      | 'ok'
      | 'not_found'
      | 'epoch'
      | 'head_ahead'
      | 'kicked'
      | 'unauthorized'
      | 'token_not_current' = 'not_found';
    this.db.transaction(() => {
      const row = this.db
        .select()
        .from(relayTenants)
        .where(eq(relayTenants.id, input.tenantId))
        .get();
      if (!row) {
        result = 'not_found';
        return;
      }
      if (row.kicked) {
        result = 'kicked';
        return;
      }
      if (
        !relayTokenHashAccepted(toTenant(row), input.tokenHash, input.now) ||
        row.tokenEpoch < input.minTokenEpoch
      ) {
        result = 'unauthorized';
        return;
      }
      if (relayTokenHashState(toTenant(row), input.tokenHash, input.now) !== 'current') {
        result = 'token_not_current';
        return;
      }
      if (row.rootEpoch !== input.expectedRootEpoch) {
        result = 'epoch';
        return;
      }
      if (input.headSeq > BigInt(row.keyLogHeadSeq)) {
        result = 'head_ahead';
        return;
      }
      this.db
        .update(relayTenants)
        .set({
          kdfParamsJson: input.kdfParamsJson,
          sealedPack: toBuffer(input.sealedPack),
          sealedPackUpdatedAt: input.now,
        })
        .where(eq(relayTenants.id, input.tenantId))
        .run();
      result = 'ok';
    });
    return result;
  }

  setKicked(tenantId: string, kicked: boolean): void {
    this.db.update(relayTenants).set({ kicked }).where(eq(relayTenants.id, tenantId)).run();
  }

  patch(
    tenantId: string,
    patch: { quota?: RelayQuota | null; label?: string | null }
  ): RelayTenantRecord | null {
    const values: Partial<RelayTenantRow> = {};
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

  /**
   * 准入注册表写入口：节点公钥**只在建行时写入**，之后任何路径都不能改（中继验不了 passkey
   * 签名，公钥只能来自建行那一次）。同一 node_id 带不同公钥 → `conflict`。
   *
   * 状态只升不降：pending → admitted；`revoked` 是终态，只能经 `patchNode` 由根签名的 revoke 写入。
   */
  upsertNode(input: {
    tenantId: string;
    nodeId: string;
    edPk: Uint8Array;
    x25519Pk: Uint8Array;
    status: RelayNodeStatusValue;
    admitSeq?: number | null;
    now: number;
  }): { node: RelayNodeRecord; outcome: RelayNodeWriteOutcome } {
    const existing = this.getNode(input.tenantId, input.nodeId);
    if (!existing) {
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
        .run();
      const node = this.getNode(input.tenantId, input.nodeId);
      if (!node) throw new Error('relay node insert failed');
      return { node, outcome: 'created' };
    }
    if (existing.status === 'revoked') return { node: existing, outcome: 'revoked' };
    if (!bytesEqual(existing.edPk, input.edPk) || !bytesEqual(existing.x25519Pk, input.x25519Pk)) {
      return { node: existing, outcome: 'conflict' };
    }
    if (existing.status === 'admitted' || input.status !== 'admitted') {
      return { node: existing, outcome: 'unchanged' };
    }
    this.db
      .update(relayNodes)
      .set({
        status: 'admitted',
        ...(input.admitSeq === undefined ? {} : { admitSeq: input.admitSeq }),
      })
      .where(and(eq(relayNodes.tenantId, input.tenantId), eq(relayNodes.nodeId, input.nodeId)))
      .run();
    const node = this.getNode(input.tenantId, input.nodeId);
    if (!node) throw new Error('relay node update failed');
    return { node, outcome: 'promoted' };
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

  /**
   * 根签名 revoke 落库：已有行改为 `revoked`；中继从没见过的 node_id 也插一条 `revoked` 行
   * （公钥置零，终态行不参与验签），它以后再也无法被 admit 或 redeem。
   */
  markNodeRevoked(tenantId: string, nodeId: string, now: number): void {
    if (this.getNode(tenantId, nodeId)) {
      this.patchNode(tenantId, nodeId, { status: 'revoked' });
      return;
    }
    const zero = new Uint8Array(32);
    this.db
      .insert(relayNodes)
      .values({
        tenantId,
        nodeId,
        edPk: toBuffer(zero),
        x25519Pk: toBuffer(zero),
        status: 'revoked',
        admitSeq: null,
        lastSeenAt: null,
        protoVersion: null,
        clientVersion: null,
        createdAt: now,
      })
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

  /** 未过期且未使用的 enrollment 数量：per-tenant 上限按它算。 */
  countUnusedEnrollments(tenantId: string, now: number): number {
    return this.db
      .select()
      .from(relayEnrollments)
      .where(
        and(
          eq(relayEnrollments.tenantId, tenantId),
          isNull(relayEnrollments.usedAt),
          sql`${relayEnrollments.expiresAt} > ${now}`
        )
      )
      .all().length;
  }

  /** 定期清理：已过期的、以及用掉超过保留期的行。 */
  sweepEnrollments(now: number, usedRetentionMs: number): number {
    const rows = this.db
      .delete(relayEnrollments)
      .where(
        or(lte(relayEnrollments.expiresAt, now), lt(relayEnrollments.usedAt, now - usedRetentionMs))
      )
      .returning()
      .all();
    return rows.length;
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
