import type { LinkSession } from '@vibeterm/shared/link';
import { type RelayCtlMessage, relaySeqToWire } from '@vibeterm/shared/relay';
import { decodeB64url } from '../api/route-input';
import type { AuthDb } from '../auth/types';
import { applyRelayEnrollCreate } from './relay-enroll-create';
import { appendRelayKeyLog, pageRelayKeyLog } from './relay-key-log-service';
import type { RelayKeyLogStore } from './relay-key-log-store';
import { type RelayLiveNode, type RelayRegistry, noteRelayPong } from './relay-registry';
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

/** 已通过准入复查的 ctl 分派；`tenant` 是复查时读到的那一份，避免再查一次库。 */
export function dispatchRelayAuthedCtl(
  host: RelayUplinkHost,
  live: RelayLiveNode,
  tenant: RelayTenantRecord,
  msg: RelayCtlMessage
): void {
  switch (msg.t) {
    case 'ping':
      host.send(live.link, { t: 'pong', token_rotated: live.tokenHash !== tenant.tokenHash });
      return;
    case 'pong':
      noteRelayPong(live, host.now());
      return;
    case 'relay.status':
      live.statusBlob = msg.blob;
      live.statusEpoch = msg.epoch;
      host.tenants.patchNode(tenant.id, live.nodeId, { lastSeenAt: host.now() });
      host.scheduleList(tenant.id);
      return;
    case 'relay.keylog.append':
      handleRelayKeyLogAppend(host, live, tenant, msg);
      return;
    case 'relay.keylog.req': {
      const page = pageRelayKeyLog({ keyLog: host.keyLog }, tenant.id, msg.from_seq, msg.limit);
      host.send(live.link, {
        t: 'relay.keylog.res',
        records: page.records,
        ...(page.hasMore ? { has_more: true } : {}),
      });
      return;
    }
    case 'relay.rtc':
      handleRelayRtc(host, live, msg);
      return;
    case 'relay.enroll.create':
      handleRelayEnrollCreate(host, live, tenant, msg);
      return;
    default:
      return;
  }
}

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
