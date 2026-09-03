import { decodeAuthorization, verifyEd25519 } from '@tmex/shared/auth';
import type { LinkSession } from '@tmex/shared/link';
import { type RelayCtlMessage, relaySeqToWire } from '@tmex/shared/relay';
import { decodeB64url } from '../api/route-input';
import { appendRelayKeyLog } from './relay-key-log-service';
import type { RelayKeyLogStore } from './relay-key-log-store';
import type { RelayMemberResult } from './relay-member';
import type { RelayLiveNode, RelayRegistry } from './relay-registry';
import type { RelayTenantStore } from './relay-tenant-store';
import { RELAY_ENROLLMENT_MAX_TTL_MS, type RelayTenantRecord } from './types';

export type RelayUplinkHost = {
  tenants: RelayTenantStore;
  keyLog: RelayKeyLogStore;
  registry: RelayRegistry;
  now: () => number;
  send(link: LinkSession, msg: RelayCtlMessage): void;
  sendTo(tenantId: string, nodeId: string, msg: RelayCtlMessage): boolean;
  scheduleList(tenantId: string): void;
  disconnectNode(tenantId: string, nodeId: string, reason: 'revoked'): void;
};

export function handleRelayRtc(
  host: RelayUplinkHost,
  live: RelayLiveNode,
  msg: Extract<RelayCtlMessage, { t: 'relay.rtc' }>
): void {
  const target = host.tenants.getNode(live.tenantId, msg.to);
  if (!target || target.status !== 'admitted') return;
  host.sendTo(live.tenantId, msg.to, msg);
}

export function handleRelayKeyLogAppend(
  host: RelayUplinkHost,
  live: RelayLiveNode,
  tenant: RelayTenantRecord,
  msg: Extract<RelayCtlMessage, { t: 'relay.keylog.append' }>
): void {
  const outcome = appendRelayKeyLog(
    { tenants: host.tenants, keyLog: host.keyLog, now: host.now },
    tenant,
    msg
  );
  if (!outcome.ok) {
    host.send(live.link, {
      t: 'relay.keylog.ack',
      id: msg.id,
      ok: false,
      error: outcome.error,
      head: relaySeqToWire(outcome.head),
    });
    return;
  }
  host.send(live.link, {
    t: 'relay.keylog.ack',
    id: msg.id,
    ok: true,
    seq: relaySeqToWire(outcome.seq),
    ...(outcome.memberIgnored ? { member_ignored: true } : {}),
  });
  if (outcome.member) applyRelayMemberEffect(host, tenant.id, outcome.member);
  for (const peer of host.registry.listTenant(tenant.id)) {
    if (peer.nodeId === live.nodeId) continue;
    host.send(peer.link, { t: 'relay.keylog.push', records: [outcome.record] });
  }
  host.scheduleList(tenant.id);
}

export function applyRelayMemberEffect(
  host: RelayUplinkHost,
  tenantId: string,
  member: RelayMemberResult
): void {
  if (!member.ok) return;
  if (member.op === 'admit') {
    host.tenants.upsertNode({
      tenantId,
      nodeId: member.nodeId,
      edPk: member.edPk,
      x25519Pk: member.x25519Pk,
      status: 'admitted',
      admitSeq: Number(member.seq),
      now: host.now(),
    });
    return;
  }
  if (!host.tenants.getNode(tenantId, member.nodeId)) return;
  host.tenants.patchNode(tenantId, member.nodeId, { status: 'revoked' });
  host.disconnectNode(tenantId, member.nodeId, 'revoked');
}

export function handleRelayEnrollCreate(
  host: RelayUplinkHost,
  live: RelayLiveNode,
  tenant: RelayTenantRecord,
  msg: Extract<RelayCtlMessage, { t: 'relay.enroll.create' }>
): void {
  const ack = (ok: boolean, error?: string): void => {
    host.send(live.link, { t: 'relay.enroll.ack', id: msg.id, ok, ...(error ? { error } : {}) });
  };
  let enrollPk: Uint8Array;
  let authorizationBytes: Uint8Array;
  let authorizationSig: Uint8Array;
  try {
    enrollPk = decodeB64url(msg.enroll_pk, 32);
    authorizationBytes = decodeB64url(msg.authorization);
    authorizationSig = decodeB64url(msg.authorization_sig, 64);
  } catch {
    ack(false, 'BAD_AUTHORIZATION');
    return;
  }
  const now = host.now();
  if (msg.exp <= now || msg.exp - now > RELAY_ENROLLMENT_MAX_TTL_MS) {
    ack(false, 'BAD_EXPIRY');
    return;
  }
  const rejected = verifyRelayAuthorization({
    enrollPk,
    authorizationBytes,
    authorizationSig,
    rootPublicKey: tenant.rootPublicKey,
  });
  if (rejected) {
    ack(false, rejected);
    return;
  }
  try {
    host.tenants.createEnrollment({
      id: msg.id,
      tenantId: tenant.id,
      enrollPk,
      authorizationBytes,
      authorizationSig,
      expiresAt: msg.exp,
      now,
    });
  } catch {
    ack(false, 'ENROLLMENT_EXISTS');
    return;
  }
  ack(true);
}

/** 中继只能验根签名的 authorization；passkey 签名验不了（plan 1.12），按令牌信任放行。 */
export function verifyRelayAuthorization(input: {
  enrollPk: Uint8Array;
  authorizationBytes: Uint8Array;
  authorizationSig: Uint8Array;
  rootPublicKey: Uint8Array;
}): string | null {
  let authorization: ReturnType<typeof decodeAuthorization>;
  try {
    authorization = decodeAuthorization(input.authorizationBytes);
  } catch {
    return 'BAD_AUTHORIZATION';
  }
  if (authorization.enroll_pk.length !== input.enrollPk.length) return 'ENROLL_PK_MISMATCH';
  for (let i = 0; i < input.enrollPk.length; i++) {
    if (authorization.enroll_pk[i] !== input.enrollPk[i]) return 'ENROLL_PK_MISMATCH';
  }
  if (authorization.signer === 'root') {
    return verifyEd25519(input.authorizationSig, input.authorizationBytes, input.rootPublicKey)
      ? null
      : 'BAD_AUTHORIZATION_SIG';
  }
  return authorization.signer === 'passkey' ? null : 'BAD_AUTHORIZATION';
}
