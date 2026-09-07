import { uplinkAuthMessage, verifyEd25519 } from '@vibeterm/shared/auth';
import type { LinkSession } from '@vibeterm/shared/link';
import {
  RELAY_PROTO_VERSION,
  type RelayCtlMessage,
  type RelayRtcConfig,
  relaySeqToWire,
} from '@vibeterm/shared/relay';
import { decodeB64url } from '../api/route-input';
import { nodeVersionMeets } from '../hub/hub-authorization';
import type { RelayConfigStore } from './relay-config-store';
import type { RelayKeyLogStore } from './relay-key-log-store';
import { verifyRelayMemberProof } from './relay-member';
import { sha256Hex } from './relay-password';
import type { RelayLiveNode, RelayRegistry } from './relay-registry';
import type { RelayTenantStore } from './relay-tenant-store';
import {
  relayPrevTokenUsable,
  relayTokenHashAccepted,
  relayTokenHashState,
} from './relay-token-grace';
import type { RelayTenantRecord } from './types';

export type RelayAuthHost = {
  tenants: RelayTenantStore;
  keyLog: RelayKeyLogStore;
  registry: RelayRegistry;
  configStore: RelayConfigStore;
  now: () => number;
  relayHost: string;
  minClientVersion: string;
  stopped: boolean;
  accepted: Set<LinkSession>;
  authBarrier?: () => Promise<void>;
  reject(link: LinkSession, reason: string): void;
  send(link: LinkSession, msg: RelayCtlMessage): void;
  startHeartbeat(live: RelayLiveNode): void;
  notifyQuota(tenantId: string): void;
  scheduleList(tenantId: string): void;
  rtcConfig(): RelayRtcConfig;
};

type PendingAuth = { nonce: Uint8Array };

/**
 * 链路存续期间复查：令牌哈希、踢出、租户 epoch、全局 min epoch。
 * 持上一代令牌的链路在宽限期内照旧有效——新令牌要经密钥日志才到得了它们手上。
 */
export function liveAuthStillValid(
  live: RelayLiveNode,
  tenant: RelayTenantRecord,
  minTokenEpoch: number,
  now: number
): boolean {
  if (tenant.kicked) return false;
  if (live.tokenEpoch < minTokenEpoch) return false;
  if (live.tokenHash === tenant.tokenHash) return live.tokenEpoch >= tenant.tokenEpoch;
  return relayPrevTokenUsable(tenant, now, live.tokenHash);
}

/** 只有仍在宽限内的历史令牌属于换代；过期、未知令牌和显式踢出均不可恢复上联。 */
function staleLinkKickReason(
  live: RelayLiveNode,
  tenant: RelayTenantRecord,
  now: number
): 'password_rotated' | 'kicked' {
  return !tenant.kicked && relayTokenHashState(tenant, live.tokenHash, now) === 'password_rotated'
    ? 'password_rotated'
    : 'kicked';
}

export type RelayRevalidateDeps = {
  tenants: RelayTenantStore;
  configStore: RelayConfigStore;
  now: () => number;
  kick: (live: RelayLiveNode, reason: 'password_rotated' | 'kicked') => void;
};

/**
 * 已认证链路的准入复查：租户还在、未被踢、令牌（当前或宽限期内的上一代）仍被接受。
 *
 * 三处调用：每条 ctl、心跳一拍、每次开流。只跑数据流的链路不产生 ctl，心跳那一拍是它唯一的
 * 复查点——少了它，持上一代令牌的链路能活过整个宽限期。
 */
export function revalidateRelayLive(
  deps: RelayRevalidateDeps,
  live: RelayLiveNode
): RelayTenantRecord | null {
  const now = deps.now();
  const tenant = deps.tenants.get(live.tenantId);
  if (!tenant) {
    live.link.close('relay-tenant-gone');
    return null;
  }
  if (liveAuthStillValid(live, tenant, deps.configStore.ensure(now).minTokenEpoch, now)) {
    return tenant;
  }
  deps.kick(live, staleLinkKickReason(live, tenant, now));
  return null;
}

export async function handleRelayAuth(
  host: RelayAuthHost,
  link: LinkSession,
  msg: Extract<RelayCtlMessage, { t: 'relay.auth' }>,
  pending: PendingAuth | undefined
): Promise<void> {
  if (!pending) {
    host.reject(link, 'auth-timeout');
    return;
  }
  const tenant = checkAuthPreconditions(host, link, msg);
  if (!tenant) return;
  const admitted = admitNode(host, tenant, msg);
  if (!admitted.ok) {
    host.reject(link, admitted.reason);
    return;
  }
  let sig: Uint8Array;
  try {
    sig = decodeB64url(msg.sig, 64);
  } catch {
    host.reject(link, 'bad-sig');
    return;
  }
  if (!verifyEd25519(sig, uplinkAuthMessage(pending.nonce, host.relayHost), admitted.edPk)) {
    host.reject(link, 'unauthorized');
    return;
  }
  await (host.authBarrier?.() ?? Promise.resolve());
  finishAuth(host, link, msg);
}

function checkAuthPreconditions(
  host: RelayAuthHost,
  link: LinkSession,
  msg: Extract<RelayCtlMessage, { t: 'relay.auth' }>
): RelayTenantRecord | null {
  if (msg.proto !== RELAY_PROTO_VERSION) {
    host.reject(link, 'proto-unsupported');
    return null;
  }
  if (!nodeVersionMeets(msg.client_version, host.minClientVersion)) {
    host.reject(link, 'client-too-old');
    return null;
  }
  const tenant = host.tenants.get(msg.tenant_id);
  if (!tenant || tenant.kicked) {
    host.reject(link, tenant ? 'tenant-kicked' : 'unknown-tenant');
    return null;
  }
  if (tenant.tokenEpoch < host.configStore.ensure(host.now()).minTokenEpoch) {
    host.reject(link, 'token-epoch');
    return null;
  }
  if (!relayTokenHashAccepted(tenant, sha256Hex(msg.token), host.now())) {
    host.reject(link, 'bad-token');
    return null;
  }
  return tenant;
}

function admitNode(
  host: RelayAuthHost,
  tenant: RelayTenantRecord,
  msg: Extract<RelayCtlMessage, { t: 'relay.auth' }>
): { ok: true; edPk: Uint8Array } | { ok: false; reason: string } {
  const node = host.tenants.getNode(tenant.id, msg.node_id);
  if (node?.status === 'revoked') return { ok: false, reason: 'revoked' };
  if (node?.status === 'admitted') return { ok: true, edPk: node.edPk };
  if (!msg.member) return { ok: false, reason: 'member-required' };
  const tolerantAdmit = host.tenants.listNodes(tenant.id).some((row) => row.status === 'admitted');
  const member = verifyRelayMemberProof({
    proof: msg.member,
    op: 'admit',
    rootPublicKey: tenant.rootPublicKey,
    rootEpoch: tenant.rootEpoch,
    expectNodeId: msg.node_id,
    tolerantAdmit,
  });
  if (!member.ok) return { ok: false, reason: `member-${member.error}` };
  if (member.op !== 'admit') return { ok: false, reason: 'member-type_mismatch' };
  const upserted = host.tenants.upsertNode({
    tenantId: tenant.id,
    nodeId: msg.node_id,
    edPk: member.edPk,
    x25519Pk: member.x25519Pk,
    status: 'admitted',
    admitSeq: Number(member.seq),
    now: host.now(),
  });
  if (upserted.status !== 'admitted') return { ok: false, reason: 'revoked' };
  return { ok: true, edPk: member.edPk };
}

function finishAuth(
  host: RelayAuthHost,
  link: LinkSession,
  msg: Extract<RelayCtlMessage, { t: 'relay.auth' }>
): void {
  if (host.stopped || !host.accepted.has(link)) return;
  const fresh = host.tenants.get(msg.tenant_id);
  const minTokenEpoch = host.configStore.ensure(host.now()).minTokenEpoch;
  if (!fresh || fresh.kicked) {
    host.reject(link, fresh ? 'tenant-kicked' : 'unknown-tenant');
    return;
  }
  const presentedHash = sha256Hex(msg.token);
  if (!relayTokenHashAccepted(fresh, presentedHash, host.now())) {
    host.reject(link, 'bad-token');
    return;
  }
  if (fresh.tokenEpoch < minTokenEpoch) {
    host.reject(link, 'token-epoch');
    return;
  }
  const now = host.now();
  const { live, replaced } = host.registry.put({
    tenantId: fresh.id,
    nodeId: msg.node_id,
    link,
    tokenEpoch: fresh.tokenEpoch,
    // 记下实际出示的那一代哈希：宽限期内的旧令牌链路不能被后续复查当成「哈希不符」踢掉
    tokenHash: presentedHash,
    protoVersion: msg.proto,
    clientVersion: msg.client_version,
    connectedAt: now,
  });
  if (replaced) replaced.link.close('relay-replaced');
  host.tenants.patchNode(fresh.id, msg.node_id, {
    lastSeenAt: now,
    protoVersion: msg.proto,
    clientVersion: msg.client_version,
  });
  host.tenants.touch(fresh.id, now);
  host.startHeartbeat(live);
  host.send(link, {
    t: 'auth.ok',
    tenant_id: fresh.id,
    token_rotated: relayTokenHashState(fresh, presentedHash, now) === 'password_rotated',
    key_log_head_seq: relaySeqToWire(host.tenants.get(fresh.id)?.keyLogHeadSeq ?? 0n),
    rtc: host.rtcConfig(),
  });
  host.notifyQuota(fresh.id);
  host.scheduleList(fresh.id);
}
