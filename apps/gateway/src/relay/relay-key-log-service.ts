import {
  RELAY_KEYLOG_PAGE_DEFAULT_LIMIT,
  RELAY_KEYLOG_PAGE_MAX_LIMIT,
  RELAY_KEYLOG_SEQ_MISMATCH,
  type RelayCtlMessage,
  type RelayKeyLogRecordWire,
  type RelaySeqWire,
  relaySeqFromWire,
  relaySeqToWire,
} from '@vibeterm/shared/relay';
import type { AuthDb } from '../auth/types';
import { AppendRejected, attributeAppend, rootOpOf } from './relay-key-log-attribution';
import { trimRelayKeyLogPage } from './relay-key-log-page';
import { type RelayKeyLogAttribution, RelayKeyLogStore } from './relay-key-log-store';
import { type RelayMemberResult, verifyRelayMemberProof } from './relay-member';
import type { RelayTenantStore } from './relay-tenant-store';
import {
  RELAY_TENANT_LOG_MAX_BYTES,
  RELAY_TENANT_LOG_MAX_ROWS,
  type RelayTenantRecord,
} from './types';

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
  | { ok: false; error: RelayAppendError; head: bigint };

export type RelayAppendError =
  | 'BAD_SEQ'
  | typeof RELAY_KEYLOG_SEQ_MISMATCH
  | 'TENANT_KICKED'
  | 'UNAUTHORIZED'
  | 'NODE_NOT_ADMITTED'
  | 'APPEND_UNATTRIBUTED'
  | 'TENANT_LOG_FULL'
  | 'APPEND_FAILED';

/**
 * 追加的写入者：
 * - `uplink`：已认证的 uplink 链路，写入者就是链路上的节点；
 * - `http`：凭租户令牌的 HTTP 追加，另需已准入节点签名（`nodeProof`），或是口令加入的自我 admit。
 */
export type RelayAppendAuth =
  | { kind: 'uplink'; nodeId: string }
  | {
      kind: 'http';
      tokenHash: string;
      minTokenEpoch: number;
      relayHost: string;
      nodeProof: { nodeId: string; sig: Uint8Array } | null;
    };

export type RelayKeyLogDeps = {
  db: AuthDb;
  tenants: RelayTenantStore;
  keyLog: RelayKeyLogStore;
  now: () => number;
  logCaps?: RelayKeyLogCaps;
};

export type RelayKeyLogCaps = { maxRows: number; maxBytes: number };

export const RELAY_KEYLOG_DEFAULT_CAPS: RelayKeyLogCaps = {
  maxRows: RELAY_TENANT_LOG_MAX_ROWS,
  maxBytes: RELAY_TENANT_LOG_MAX_BYTES,
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
): { revokedNodeId: string | null; rootRotated: boolean; refused: string | null } {
  const idle = { revokedNodeId: null, rootRotated: false, refused: null };
  if (!member.ok) return idle;
  if (member.op === 'admit') {
    const written = deps.tenants.upsertNode({
      tenantId: tenant.id,
      nodeId: member.nodeId,
      edPk: member.edPk,
      x25519Pk: member.x25519Pk,
      status: 'admitted',
      admitSeq: Number(member.seq),
      now: deps.now(),
    });
    if (written.outcome === 'conflict') return { ...idle, refused: 'member_conflict' };
    // `revoked` 是终态：被吊销的节点永远不会因为一条（可能是重放的）admit 复活
    return { ...idle, refused: written.node.status === 'admitted' ? null : 'effect_refused' };
  }
  if (member.op === 'revoke') {
    // 中继从没见过的节点（纯 LAN 节点）同样持有令牌与 K_log：照样收紧令牌，并留一条 revoked 行
    deps.tenants.markNodeRevoked(tenant.id, member.nodeId, deps.now());
    deps.tenants.restrictTokensAfterRevoke(tenant.id, deps.now());
    return { ...idle, revokedNodeId: member.nodeId };
  }
  const rotated = deps.tenants.rotateRoot({
    tenantId: tenant.id,
    expectedRootEpoch: member.rootEpoch,
    rootPublicKey: member.newRootPublicKey,
    rootEpoch: member.nextRootEpoch,
  });
  return { ...idle, rootRotated: rotated, refused: rotated ? null : 'effect_refused' };
}

function attributionOf(
  auth: RelayAppendAuth,
  appendedBy: string,
  member: RelayMemberResult | null
): RelayKeyLogAttribution {
  const rootOp = rootOpOf(member);
  return {
    appendedBy,
    rootOp,
    via: auth.kind,
    admittedNodeId:
      rootOp === 'admit' && member?.ok && member.op === 'admit' ? member.nodeId : null,
  };
}

function enforceCaps(
  deps: RelayKeyLogDeps,
  tenantId: string,
  seq: bigint,
  storedBytes: number,
  head: bigint
): void {
  const caps = deps.logCaps ?? RELAY_KEYLOG_DEFAULT_CAPS;
  if (seq > BigInt(caps.maxRows)) throw new AppendRejected('TENANT_LOG_FULL', head);
  if (deps.keyLog.bytes(tenantId) + storedBytes > caps.maxBytes) {
    throw new AppendRejected('TENANT_LOG_FULL', head);
  }
}

type MemberEffects = ReturnType<typeof applyMemberInTx>;

const IDLE_EFFECTS: MemberEffects = { revokedNodeId: null, rootRotated: false, refused: null };

type AppendTxInput = {
  msg: Extract<RelayCtlMessage, { t: 'relay.keylog.append' }>;
  seq: bigint;
  head: bigint;
  member: MemberOutcome;
  now: number;
};

/** 事务体：复查 head → 归属 → 上限 → 落行与 head → 成员副作用。`state.touched` 标记已动过存储。 */
function writeAppendInTx(
  deps: RelayKeyLogDeps,
  tenant: RelayTenantRecord,
  auth: RelayAppendAuth,
  input: AppendTxInput,
  state: { touched: boolean }
): MemberEffects {
  const { msg, seq, head, member, now } = input;
  const current = deps.tenants.get(tenant.id);
  if (!current || current.keyLogHeadSeq !== head) {
    throw new AppendRejected(RELAY_KEYLOG_SEQ_MISMATCH, current?.keyLogHeadSeq ?? head);
  }
  const appendedBy = attributeAppend(
    deps,
    current,
    auth,
    {
      seq,
      head,
      envelope: msg.blob,
      member: member.result,
      hasMember: msg.member !== undefined,
    },
    now
  );
  const attribution = attributionOf(auth, appendedBy, member.result);
  const stored = RelayKeyLogStore.storedJson({ envelope: msg.blob, ...attribution });
  enforceCaps(deps, tenant.id, seq, RelayKeyLogStore.storedBytes(stored), head);
  state.touched = true;
  deps.keyLog.append({ tenantId: tenant.id, seq, envelope: msg.blob, ...attribution, now });
  deps.tenants.setKeyLogHead(tenant.id, seq);
  return member.result ? applyMemberInTx(deps, tenant, member.result) : IDLE_EFFECTS;
}

/**
 * 追加一条密钥日志：`seq` 必须等于 head+1，日志行 / head / 成员副作用在同一个 SQLite 事务里提交。
 *
 * - 写入必须可归属（`attributeAppend`），行上记下写入者、写入路径与根签名 admit 准入的节点；
 * - `member` 的明文记录必须**就是本次 seq 的那一条**且 `root_epoch` 等于租户当前根 epoch
 *   （见 `verifyRelayMemberProof`）；不满足就忽略并回 `member_ignored`，日志本身照旧落库；
 * - 中继从不改写已有的行：任何 `seq <= head` 的追加（包括根签名记录）都回 SEQ_MISMATCH；
 * - 只有事务里已动过存储或内部失败时才丢字节缓存；被拒的请求不碰缓存。
 */
export function appendRelayKeyLog(
  deps: RelayKeyLogDeps,
  tenant: RelayTenantRecord,
  msg: Extract<RelayCtlMessage, { t: 'relay.keylog.append' }>,
  auth: RelayAppendAuth
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
  const state = { touched: false };
  let effects: MemberEffects = IDLE_EFFECTS;
  try {
    deps.db.transaction(() => {
      effects = writeAppendInTx(deps, tenant, auth, { msg, seq, head, member, now }, state);
    });
  } catch (err) {
    const rejected = err instanceof AppendRejected;
    if (state.touched || !rejected) deps.keyLog.forgetBytes(tenant.id);
    if (rejected) return { ok: false, error: err.code, head: err.head };
    console.warn(`[relay] key-log append failed tenant=${tenant.id} err=${String(err)}`);
    return { ok: false, error: 'APPEND_FAILED', head };
  }
  const memberError = member.error ?? effects.refused;
  return {
    ok: true,
    seq,
    head: seq,
    memberIgnored: memberError !== null,
    memberError,
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
