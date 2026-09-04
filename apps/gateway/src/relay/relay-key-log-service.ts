import {
  RELAY_KEYLOG_PAGE_DEFAULT_LIMIT,
  RELAY_KEYLOG_PAGE_MAX_LIMIT,
  RELAY_KEYLOG_SEQ_MISMATCH,
  type RelayCtlMessage,
  type RelayKeyLogRecordWire,
  type RelaySeqWire,
  relaySeqFromWire,
  relaySeqToWire,
} from '@tmex/shared/relay';
import type { AuthDb } from '../auth/types';
import { trimRelayKeyLogPage } from './relay-key-log-page';
import type { RelayKeyLogStore } from './relay-key-log-store';
import { type RelayMemberResult, verifyRelayMemberProof } from './relay-member';
import type { RelayTenantStore } from './relay-tenant-store';
import type { RelayTenantRecord } from './types';

export type RelayAppendOutcome =
  | {
      ok: true;
      seq: bigint;
      head: bigint;
      memberIgnored: boolean;
      memberError: string | null;
      /** 事务里已经落库的成员副作用；链路层的踢人/广播在事务外做。 */
      revokedNodeId: string | null;
      rootRotated: boolean;
      record: RelayKeyLogRecordWire;
    }
  | { ok: false; error: string; head: bigint };

export type RelayKeyLogDeps = {
  db: AuthDb;
  tenants: RelayTenantStore;
  keyLog: RelayKeyLogStore;
  now: () => number;
};

type MemberOutcome = { result: RelayMemberResult | null; error: string | null };

/** 成员明文只做校验，不写库：写库在下面的事务里跟日志行一起提交。 */
function verifyMember(
  deps: RelayKeyLogDeps,
  tenant: RelayTenantRecord,
  msg: Extract<RelayCtlMessage, { t: 'relay.keylog.append' }>,
  seq: bigint
): MemberOutcome {
  const member = msg.member;
  if (!member) return { result: null, error: null };
  const tolerantAdmit =
    member.op === 'admit' &&
    deps.tenants.listNodes(tenant.id).some((node) => node.status === 'admitted');
  const result = verifyRelayMemberProof({
    proof: { bytes: member.bytes, sig: member.sig },
    op: member.op,
    rootPublicKey: tenant.rootPublicKey,
    rootEpoch: tenant.rootEpoch,
    expectSeq: seq,
    tolerantAdmit,
  });
  if (!result.ok) return { result: null, error: result.error };
  return { result, error: null };
}

/** 事务内的成员副作用；返回需要在事务外处理的链路动作。 */
function applyMemberInTx(
  deps: RelayKeyLogDeps,
  tenant: RelayTenantRecord,
  member: RelayMemberResult
): { revokedNodeId: string | null; rootRotated: boolean; refused: boolean } {
  const idle = { revokedNodeId: null, rootRotated: false, refused: false };
  if (!member.ok) return idle;
  if (member.op === 'admit') {
    const node = deps.tenants.upsertNode({
      tenantId: tenant.id,
      nodeId: member.nodeId,
      edPk: member.edPk,
      x25519Pk: member.x25519Pk,
      status: 'admitted',
      admitSeq: Number(member.seq),
      now: deps.now(),
    });
    // `revoked` 是终态：被吊销的节点永远不会因为一条（可能是重放的）admit 复活
    return { ...idle, refused: node.status !== 'admitted' };
  }
  if (member.op === 'revoke') {
    if (!deps.tenants.getNode(tenant.id, member.nodeId)) return { ...idle, refused: true };
    deps.tenants.patchNode(tenant.id, member.nodeId, { status: 'revoked' });
    return { revokedNodeId: member.nodeId, rootRotated: false, refused: false };
  }
  const rotated = deps.tenants.rotateRoot({
    tenantId: tenant.id,
    expectedRootEpoch: member.rootEpoch,
    rootPublicKey: member.newRootPublicKey,
    rootEpoch: member.nextRootEpoch,
  });
  return { revokedNodeId: null, rootRotated: rotated, refused: !rotated };
}

/**
 * 追加一条密钥日志：`seq` 必须等于 head+1，日志行 / head / 成员副作用在同一个 SQLite 事务里提交。
 *
 * `member` 的明文记录必须**就是本次 seq 的那一条**且 `root_epoch` 等于租户当前根 epoch
 * （见 `verifyRelayMemberProof`）；不满足就整条忽略并回 `member_ignored`，日志本身照旧落库
 * （中继看不到密文，无从判断内容，成员表只是链路准入缓存）。
 */
export function appendRelayKeyLog(
  deps: RelayKeyLogDeps,
  tenant: RelayTenantRecord,
  msg: Extract<RelayCtlMessage, { t: 'relay.keylog.append' }>,
  writeAuth?: { tokenHash: string; minTokenEpoch: number }
): RelayAppendOutcome {
  const head = tenant.keyLogHeadSeq;
  let seq: bigint;
  try {
    seq = relaySeqFromWire(msg.seq);
  } catch {
    return { ok: false, error: 'BAD_SEQ', head };
  }
  if (seq !== head + 1n) {
    return { ok: false, error: RELAY_KEYLOG_SEQ_MISMATCH, head };
  }
  const member = verifyMember(deps, tenant, msg, seq);
  const now = deps.now();
  let effects = { revokedNodeId: null as string | null, rootRotated: false, refused: false };
  let conflictHead: bigint | null = null;
  let authError: 'TENANT_KICKED' | 'UNAUTHORIZED' | null = null;
  try {
    deps.db.transaction(() => {
      const current = deps.tenants.get(tenant.id);
      if (!current || current.keyLogHeadSeq !== head) {
        conflictHead = current?.keyLogHeadSeq ?? head;
        throw new Error('relay-keylog-head-conflict');
      }
      if (writeAuth) {
        if (current.kicked) {
          authError = 'TENANT_KICKED';
          throw new Error('relay-keylog-auth');
        }
        if (
          current.tokenHash !== writeAuth.tokenHash ||
          current.tokenEpoch < writeAuth.minTokenEpoch
        ) {
          authError = 'UNAUTHORIZED';
          throw new Error('relay-keylog-auth');
        }
      }
      deps.keyLog.append({ tenantId: tenant.id, seq, envelope: msg.blob, now });
      deps.tenants.setKeyLogHead(tenant.id, seq);
      if (member.result) effects = applyMemberInTx(deps, tenant, member.result);
    });
  } catch (err) {
    if (authError) return { ok: false, error: authError, head };
    if (conflictHead !== null) {
      return { ok: false, error: RELAY_KEYLOG_SEQ_MISMATCH, head: conflictHead };
    }
    console.warn(`[relay] key-log append failed tenant=${tenant.id} err=${String(err)}`);
    return { ok: false, error: 'APPEND_FAILED', head };
  }
  return {
    ok: true,
    seq,
    head: seq,
    memberIgnored: member.error !== null || effects.refused,
    memberError: member.error ?? (effects.refused ? 'effect_refused' : null),
    revokedNodeId: effects.revokedNodeId,
    rootRotated: effects.rootRotated,
    record: { seq: relaySeqToWire(seq), blob: msg.blob },
  };
}

export function pageRelayKeyLog(
  deps: Pick<RelayKeyLogDeps, 'keyLog'>,
  tenantId: string,
  fromSeqWire: RelaySeqWire,
  limitRaw: number | undefined
): { records: RelayKeyLogRecordWire[]; hasMore: boolean } {
  let fromSeq: bigint;
  try {
    fromSeq = relaySeqFromWire(fromSeqWire);
  } catch {
    return { records: [], hasMore: false };
  }
  if (fromSeq < 1n) fromSeq = 1n;
  const limit = Math.min(
    Math.max(1, limitRaw ?? RELAY_KEYLOG_PAGE_DEFAULT_LIMIT),
    RELAY_KEYLOG_PAGE_MAX_LIMIT
  );
  const rows = deps.keyLog.list(tenantId, fromSeq, limit + 1);
  const hasMore = rows.length > limit;
  return trimRelayKeyLogPage(rows.slice(0, limit), hasMore, { type: 'relay.keylog.res' });
}
