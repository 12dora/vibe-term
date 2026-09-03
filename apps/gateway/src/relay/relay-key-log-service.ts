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
      member: RelayMemberResult | null;
      record: RelayKeyLogRecordWire;
    }
  | { ok: false; error: string; head: bigint };

export type RelayKeyLogDeps = {
  tenants: RelayTenantStore;
  keyLog: RelayKeyLogStore;
  now: () => number;
};

/**
 * 追加一条密钥日志：`seq` 必须等于 head+1；`member` 附带的成员记录用于维护中继注册表
 * （admit 允许 passkey 签名，revoke 只认根签名，被忽略时置 `member_ignored`）。
 */
export function appendRelayKeyLog(
  deps: RelayKeyLogDeps,
  tenant: RelayTenantRecord,
  msg: Extract<RelayCtlMessage, { t: 'relay.keylog.append' }>
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
  const member = msg.member ?? null;
  let memberResult: RelayMemberResult | null = null;
  let memberIgnored = false;
  if (member) {
    const tolerantAdmit =
      member.op === 'admit' &&
      deps.tenants.listNodes(tenant.id).some((node) => node.status === 'admitted');
    memberResult = verifyRelayMemberProof({
      proof: { bytes: member.bytes, sig: member.sig },
      op: member.op,
      rootPublicKey: tenant.rootPublicKey,
      tolerantAdmit,
    });
    if (!memberResult.ok) {
      memberIgnored = true;
      memberResult = null;
    }
  }
  const now = deps.now();
  deps.keyLog.append({ tenantId: tenant.id, seq, envelope: msg.blob, now });
  deps.tenants.setKeyLogHead(tenant.id, seq);
  return {
    ok: true,
    seq,
    head: seq,
    memberIgnored,
    member: memberResult,
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
