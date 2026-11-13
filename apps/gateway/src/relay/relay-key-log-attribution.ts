import type { RelayEnvelope, RelayKeylogMemberOp } from '@vibeterm/shared/relay';
import { verifyRelayKeyLogAppend } from './relay-append-proof';
import type { RelayAppendAuth, RelayAppendError, RelayKeyLogDeps } from './relay-key-log-service';
import type { RelayMemberResult } from './relay-member';
import { relayTokenHashAccepted } from './relay-token-grace';
import { RELAY_JOIN_FOLLOWUP_WINDOW_MS, type RelayTenantRecord } from './types';

export class AppendRejected extends Error {
  constructor(
    readonly code: RelayAppendError,
    readonly head: bigint
  ) {
    super(code);
  }
}

export type AppendAttributionInput = {
  seq: bigint;
  head: bigint;
  envelope: RelayEnvelope;
  member: RelayMemberResult | null;
  /** 请求是否带了成员明文（不论验没验过）。 */
  hasMember: boolean;
};

type HttpAuth = Extract<RelayAppendAuth, { kind: 'http' }>;

export function rootOpOf(member: RelayMemberResult | null): RelayKeylogMemberOp | null {
  if (!member?.ok || member.signer !== 'root') return null;
  return member.op;
}

function nodeSigValid(
  auth: HttpAuth,
  edPk: Uint8Array,
  tenantId: string,
  input: AppendAttributionInput
): boolean {
  if (!auth.nodeProof) return false;
  return verifyRelayKeyLogAppend(auth.nodeProof.sig, edPk, {
    relayHost: auth.relayHost,
    tenantId,
    seq: input.seq,
    envelope: input.envelope,
  });
}

function admittedNodeProof(
  deps: RelayKeyLogDeps,
  tenantId: string,
  auth: HttpAuth,
  input: AppendAttributionInput
): string | null {
  if (!auth.nodeProof) return null;
  const node = deps.tenants.getNode(tenantId, auth.nodeProof.nodeId);
  if (node?.status !== 'admitted') return null;
  return nodeSigValid(auth, node.edPk, tenantId, input) ? auth.nodeProof.nodeId : null;
}

/**
 * HTTP 上只凭根签名 sidecar 归属的唯一情形：口令加入的自我 admit。
 * 被 admit 的节点尚未准入，且请求带着它用证书 `ed_pk` 签的 `node_sig`；
 * 不带 `node_sig` 的（2.14 与当前 CLI）只在中继完全不认识该 node_id 时放行。
 */
function selfAdmit(
  deps: RelayKeyLogDeps,
  tenantId: string,
  auth: HttpAuth,
  input: AppendAttributionInput
): string | null {
  const member = input.member;
  if (!member?.ok || member.op !== 'admit' || member.signer !== 'root') return null;
  const row = deps.tenants.getNode(tenantId, member.nodeId);
  if (row && row.status !== 'pending') return null;
  if (!auth.nodeProof) return row ? null : member.nodeId;
  if (auth.nodeProof.nodeId !== member.nodeId) return null;
  return nodeSigValid(auth, member.edPk, tenantId, input) ? member.nodeId : null;
}

/**
 * 旧版 CLI 口令加入（2.14）自我准入后凭令牌追加紧随的 `meta-key`，不带节点签名、不带成员明文。
 * 只放行这一条：上一行必须是 HTTP 写入、窗口内的根签名 admit，且写入者就是它准入的节点。
 */
function legacyJoinFollowUp(
  deps: RelayKeyLogDeps,
  tenantId: string,
  input: AppendAttributionInput,
  now: number
): string | null {
  if (input.hasMember || input.head < 1n) return null;
  const prev = deps.keyLog.getMeta(tenantId, input.head);
  if (prev?.via !== 'http' || prev.rootOp !== 'admit') return null;
  if (!prev.appendedBy || prev.admittedNodeId !== prev.appendedBy) return null;
  if (now - prev.createdAt > RELAY_JOIN_FOLLOWUP_WINDOW_MS) return null;
  const node = deps.tenants.getNode(tenantId, prev.appendedBy);
  return node?.status === 'admitted' ? prev.appendedBy : null;
}

/**
 * 归属写入者（按序）：uplink 链路节点 → HTTP 上已准入节点的签名 → 口令加入的自我 admit →
 * 旧版 CLI 口令加入的紧随追加。都不满足就拒绝。
 */
export function attributeAppend(
  deps: RelayKeyLogDeps,
  current: RelayTenantRecord,
  auth: RelayAppendAuth,
  input: AppendAttributionInput,
  now: number
): string {
  if (auth.kind === 'uplink') {
    const node = deps.tenants.getNode(current.id, auth.nodeId);
    if (node?.status !== 'admitted') throw new AppendRejected('NODE_NOT_ADMITTED', input.head);
    return auth.nodeId;
  }
  if (current.kicked) throw new AppendRejected('TENANT_KICKED', input.head);
  if (
    !relayTokenHashAccepted(current, auth.tokenHash, now) ||
    current.tokenEpoch < auth.minTokenEpoch
  ) {
    throw new AppendRejected('UNAUTHORIZED', input.head);
  }
  const by =
    admittedNodeProof(deps, current.id, auth, input) ??
    selfAdmit(deps, current.id, auth, input) ??
    legacyJoinFollowUp(deps, current.id, input, now);
  if (!by) throw new AppendRejected('APPEND_UNATTRIBUTED', input.head);
  return by;
}
