import type { LinkSession } from '@tmex/shared/link';
import { type RelayCtlMessage, relaySeqToWire } from '@tmex/shared/relay';
import { decodeB64url } from '../api/route-input';
import type { AuthDb } from '../auth/types';
import { applyRelayEnrollCreate } from './relay-enroll-create';
import { appendRelayKeyLog } from './relay-key-log-service';
import type { RelayKeyLogStore } from './relay-key-log-store';
import type { RelayLiveNode, RelayRegistry } from './relay-registry';
import type { RelayTenantStore } from './relay-tenant-store';
import type { RelayTenantRecord } from './types';

export { verifyRelayAuthorization } from './relay-enroll-create';

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
  const result = applyRelayEnrollCreate(host, tenant, { id: msg.id, exp: msg.exp, ...parsed });
  ack(result.ok, result.ok ? undefined : result.error);
}
