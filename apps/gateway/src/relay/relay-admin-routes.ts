import { readJsonObjectBody } from '@tmex/shared/http';
import type { RelayConfigStore } from './relay-config-store';
import { RelayErrorCode, relayError, relayJson } from './relay-http';
import type { RelayKeyLogStore } from './relay-key-log-store';
import type { RelayMetering } from './relay-metering';
import type { RelayMetricsCollector, RelayMetricsResponse } from './relay-metrics';
import { hashRelayPassword, relayPasswordTooShort } from './relay-password';
import { normalizeRelayQuota } from './relay-quota';
import type { RelayRegistry } from './relay-registry';
import type { RelayTenantStore } from './relay-tenant-store';
import type { RelayUplinkServer } from './relay-uplink-server';

export const RELAY_LABEL_MAX_LENGTH = 128;

export type RelayAdminDeps = {
  tenants: RelayTenantStore;
  keyLog: RelayKeyLogStore;
  configStore: RelayConfigStore;
  registry: RelayRegistry;
  metering: RelayMetering;
  metrics: RelayMetricsCollector;
  uplink: RelayUplinkServer;
  now: () => number;
};

export function relayStatusPayload(deps: RelayAdminDeps): Response {
  const config = deps.configStore.ensure(deps.now());
  const totals = { tenants: 0, nodes: 0, nodesOnline: 0, streams: 0, bytesIn: 0, bytesOut: 0 };
  const tenants = deps.tenants.list().map((tenant) => {
    const live = deps.registry.listTenant(tenant.id);
    const pending = deps.metering.pendingFor(tenant.id);
    const streams = deps.registry.streamCount(tenant.id);
    // 与 countActiveNodes 同口径：revoked 是终态，既不占配额，也不该永远挂在「已知节点」里。
    const nodeRecords = deps.tenants.listNodes(tenant.id);
    const nodesRevoked = nodeRecords.filter((node) => node.status === 'revoked').length;
    const nodes = deps.tenants.countActiveNodes(tenant.id);
    const bytesIn = tenant.bytesIn + pending.bytesIn;
    const bytesOut = tenant.bytesOut + pending.bytesOut;
    totals.tenants += 1;
    totals.nodes += nodes;
    totals.nodesOnline += live.length;
    totals.streams += streams;
    totals.bytesIn += bytesIn;
    totals.bytesOut += bytesOut;
    return {
      id: tenant.id,
      label: tenant.label,
      createdAt: tenant.createdAt,
      lastSeenAt: tenant.lastSeenAt,
      nodes,
      nodesRevoked,
      nodesOnline: live.length,
      streams,
      bytesIn,
      bytesOut,
      quota: tenant.quota,
      tokenEpoch: tenant.tokenEpoch,
      kicked: tenant.kicked,
    };
  });
  return relayJson({
    config: {
      hasPassword: config.passwordHash !== null,
      passwordEpoch: config.passwordEpoch,
      minTokenEpoch: config.minTokenEpoch,
      defaultQuota: config.defaultQuota,
    },
    tenants,
    totals,
  });
}

/**
 * `bytesIn` = 从成员收到的字节，`bytesOut` = 发给成员的字节。
 * 租户累计对同一份中转字节 in/out 各记一次；响应不含令牌、密钥、密封包或 key-log 原文。
 */
export function handleRelayMetrics(deps: RelayAdminDeps, req: Request): Response {
  const includeMembers = new URL(req.url).searchParams.get('members') !== '0';
  const snap: RelayMetricsResponse = deps.metrics.snapshot();
  if (includeMembers) return relayJson(snap);
  const { members: _members, ...rest } = snap;
  return relayJson(rest);
}

export async function handleRelayPassword(deps: RelayAdminDeps, req: Request): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body) return relayError(RelayErrorCode.invalidBody, 400);
  const mode = body.mode;
  if (mode !== 'kick' && mode !== 'keep') return relayError(RelayErrorCode.invalidBody, 400);
  const password = body.password;
  if (password !== null && (typeof password !== 'string' || password.length === 0)) {
    return relayError(RelayErrorCode.invalidBody, 400);
  }
  if (typeof password === 'string' && relayPasswordTooShort(password)) {
    return relayError(RelayErrorCode.invalidBody, 400);
  }
  const passwordHash = password === null ? null : await hashRelayPassword(password);
  const next = deps.configStore.rotatePassword({
    passwordHash,
    kick: mode === 'kick',
    now: deps.now(),
  });
  if (mode === 'kick') deps.uplink.enforceMinTokenEpoch(next.minTokenEpoch);
  return relayJson({ ok: true, passwordEpoch: next.passwordEpoch });
}

export async function handleRelayConfigPatch(
  deps: RelayAdminDeps,
  req: Request
): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body) return relayError(RelayErrorCode.invalidBody, 400);
  const quota = normalizeRelayQuota(body.defaultQuota);
  if (!quota) return relayError(RelayErrorCode.badQuota, 400);
  deps.configStore.setDefaultQuota(quota, deps.now());
  for (const tenant of deps.tenants.list()) {
    if (tenant.quota === null) deps.uplink.notifyQuota(tenant.id);
  }
  return relayJson({ ok: true });
}

export async function handleRelayTenantPatch(
  deps: RelayAdminDeps,
  req: Request,
  tenantId: string
): Promise<Response> {
  if (!deps.tenants.get(tenantId)) return relayError(RelayErrorCode.tenantNotFound, 404);
  const body = await readJsonObjectBody(req);
  if (!body) return relayError(RelayErrorCode.invalidBody, 400);
  const patch: { quota?: ReturnType<typeof normalizeRelayQuota>; label?: string | null } = {};
  if ('quota' in body) {
    if (body.quota === null) {
      patch.quota = null;
    } else {
      const quota = normalizeRelayQuota(body.quota);
      if (!quota) return relayError(RelayErrorCode.badQuota, 400);
      patch.quota = quota;
    }
  }
  if ('label' in body) {
    const label = body.label;
    if (label === null) {
      patch.label = null;
    } else if (typeof label === 'string' && label.length <= RELAY_LABEL_MAX_LENGTH) {
      patch.label = label.trim() || null;
    } else {
      return relayError(RelayErrorCode.invalidBody, 400);
    }
  }
  deps.tenants.patch(tenantId, patch);
  if (patch.quota !== undefined) deps.uplink.notifyQuota(tenantId);
  return relayJson({ ok: true });
}

export function handleRelayTenantKick(deps: RelayAdminDeps, tenantId: string): Response {
  if (!deps.tenants.get(tenantId)) return relayError(RelayErrorCode.tenantNotFound, 404);
  deps.tenants.setKicked(tenantId, true);
  deps.uplink.kickTenant(tenantId, 'kicked');
  return relayJson({ ok: true });
}

export function handleRelayTenantDelete(deps: RelayAdminDeps, tenantId: string): Response {
  if (!deps.tenants.get(tenantId)) return relayError(RelayErrorCode.tenantNotFound, 404);
  deps.uplink.kickTenant(tenantId, 'kicked');
  deps.uplink.forgetTenant(tenantId);
  deps.metering.forgetTenant(tenantId);
  deps.registry.forgetTenant(tenantId);
  deps.keyLog.deleteAll(tenantId);
  deps.tenants.remove(tenantId);
  return relayJson({ ok: true });
}
