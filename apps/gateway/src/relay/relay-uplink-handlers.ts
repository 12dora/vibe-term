import { decodeAuthorization, verifyEd25519 } from '@tmex/shared/auth';
import type { LinkSession } from '@tmex/shared/link';
import { type RelayCtlMessage, relaySeqToWire } from '@tmex/shared/relay';
import { decodeB64url } from '../api/route-input';
import type { AuthDb } from '../auth/types';
import { appendRelayKeyLog } from './relay-key-log-service';
import type { RelayKeyLogStore } from './relay-key-log-store';
import { ED25519_SIG_BYTES } from './relay-member';
import type { RelayLiveNode, RelayRegistry } from './relay-registry';
import type { RelayTenantStore } from './relay-tenant-store';
import {
  RELAY_ENROLLMENT_MAX_TTL_MS,
  RELAY_MAX_UNUSED_ENROLLMENTS,
  type RelayTenantRecord,
} from './types';

export type RelayUplinkHost = {
  db: AuthDb;
  tenants: RelayTenantStore;
  keyLog: RelayKeyLogStore;
  registry: RelayRegistry;
  now: () => number;
  send(link: LinkSession, msg: RelayCtlMessage): void;
  sendTo(tenantId: string, nodeId: string, msg: RelayCtlMessage): boolean;
  scheduleList(tenantId: string): void;
  disconnectNode(tenantId: string, nodeId: string, reason: 'revoked'): void;
  notifyQuota(tenantId: string): void;
  /** 每租户 `relay.enroll.create` 频率闸；超了返回 false。 */
  allowEnrollCreate(tenantId: string): boolean;
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
    { db: host.db, tenants: host.tenants, keyLog: host.keyLog, now: host.now },
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
    ...(outcome.memberError ? { member_error: outcome.memberError } : {}),
  });
  if (outcome.revokedNodeId) {
    host.disconnectNode(tenant.id, outcome.revokedNodeId, 'revoked');
  }
  if (msg.member && !outcome.memberIgnored) {
    host.notifyQuota(tenant.id);
  }
  for (const peer of host.registry.listTenant(tenant.id)) {
    if (peer.nodeId === live.nodeId) continue;
    host.send(peer.link, { t: 'relay.keylog.push', records: [outcome.record] });
  }
  host.scheduleList(tenant.id);
}

function parseEnrollCreate(
  msg: Extract<RelayCtlMessage, { t: 'relay.enroll.create' }>
): { enrollPk: Uint8Array; authorizationBytes: Uint8Array; authorizationSig: Uint8Array } | null {
  try {
    return {
      enrollPk: decodeB64url(msg.enroll_pk, 32),
      authorizationBytes: decodeB64url(msg.authorization),
      authorizationSig: decodeB64url(msg.authorization_sig),
    };
  } catch {
    return null;
  }
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
  const parsed = parseEnrollCreate(msg);
  if (!parsed) {
    ack(false, 'BAD_AUTHORIZATION');
    return;
  }
  const now = host.now();
  if (msg.exp <= now || msg.exp - now > RELAY_ENROLLMENT_MAX_TTL_MS) {
    ack(false, 'BAD_EXPIRY');
    return;
  }
  const rejected = verifyRelayAuthorization({
    ...parsed,
    rootPublicKey: tenant.rootPublicKey,
    rootEpoch: tenant.rootEpoch,
    exp: msg.exp,
  });
  if (rejected) {
    ack(false, rejected);
    return;
  }
  if (host.tenants.countUnusedEnrollments(tenant.id, now) >= RELAY_MAX_UNUSED_ENROLLMENTS) {
    ack(false, 'ENROLLMENT_QUOTA');
    return;
  }
  if (!host.allowEnrollCreate(tenant.id)) {
    ack(false, 'ENROLLMENT_RATE_LIMITED');
    return;
  }
  try {
    host.tenants.createEnrollment({
      id: msg.id,
      tenantId: tenant.id,
      enrollPk: parsed.enrollPk,
      authorizationBytes: parsed.authorizationBytes,
      authorizationSig: parsed.authorizationSig,
      expiresAt: msg.exp,
      now,
    });
  } catch {
    ack(false, 'ENROLLMENT_EXISTS');
    return;
  }
  ack(true);
}

/**
 * 中继只能验根签名的 authorization；passkey 签名验不了（plan 1.12），按令牌信任放行。
 * 无论哪种签名，`root_epoch` 都必须是租户**当前**的 epoch，`exp` 不得超过 authorization 自身的到期。
 */
export function verifyRelayAuthorization(input: {
  enrollPk: Uint8Array;
  authorizationBytes: Uint8Array;
  authorizationSig: Uint8Array;
  rootPublicKey: Uint8Array;
  rootEpoch: number;
  exp: number;
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
  if (authorization.root_epoch !== input.rootEpoch) return 'ROOT_EPOCH_MISMATCH';
  if (BigInt(input.exp) > authorization.exp) return 'BAD_EXPIRY';
  if (authorization.signer === 'root') {
    if (input.authorizationSig.byteLength !== ED25519_SIG_BYTES) return 'BAD_AUTHORIZATION_SIG';
    return verifyEd25519(input.authorizationSig, input.authorizationBytes, input.rootPublicKey)
      ? null
      : 'BAD_AUTHORIZATION_SIG';
  }
  return authorization.signer === 'passkey' ? null : 'BAD_AUTHORIZATION';
}
