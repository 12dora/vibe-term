import { readJsonObjectBody } from '@vibeterm/shared/http';
import { config as gatewayConfig } from '../config';
import { membersProbeSnapshot } from '../mesh/port-reach';
import type { RelayConfigStore } from './relay-config-store';
import { RelayErrorCode, relayError, relayJson } from './relay-http';
import type { RelayKeyLogStore } from './relay-key-log-store';
import { normalizeRelayLimits } from './relay-limits';
import type { RelayMetering } from './relay-metering';
import type { RelayMetricsCollector, RelayMetricsResponse } from './relay-metrics';
import { hashRelayPassword, relayPasswordTooShort } from './relay-password';
import { normalizeRelayQuota } from './relay-quota';
import type { RelayRegistry } from './relay-registry';
import type { RelayTenantStore } from './relay-tenant-store';
import { EMPTY_RELAY_TURN_STATUS, type RelayTurnStatus } from './relay-turn-config';
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
  turnStatus?: () => RelayTurnStatus;
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
      limits: config.limits,
    },
    tenants,
    totals,
    turn: withMembersProbe(deps.turnStatus?.() ?? EMPTY_RELAY_TURN_STATUS),
  });
}

export function withMembersProbe(turn: RelayTurnStatus, relayKey?: string): RelayTurnStatus {
  const key = (relayKey ?? gatewayConfig.relayPublicUrl)?.trim() || undefined;
  const membersProbe = membersProbeSnapshot(key);
  return membersProbe ? { ...turn, membersProbe } : turn;
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

function offlineMembersGuard(
  deps: RelayAdminDeps,
  tenantIds: string[],
  force: unknown
): Response | null {
  if (force === true) return null;
  let online = 0;
  let admitted = 0;
  for (const tenantId of tenantIds) {
    const members = deps.tenants.listNodes(tenantId).filter((node) => node.status === 'admitted');
    admitted += members.length;
    online += members.filter((node) => deps.registry.get(tenantId, node.nodeId)).length;
  }
  return online < admitted
    ? relayError(RelayErrorCode.membersOffline, 409, { online, admitted })
    : null;
}

export async function handleRelayPassword(deps: RelayAdminDeps, req: Request): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body) return relayError(RelayErrorCode.invalidBody, 400);
  if ('force' in body && typeof body.force !== 'boolean') {
    return relayError(RelayErrorCode.invalidBody, 400);
  }
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
  if (mode === 'kick') {
    const blocked = offlineMembersGuard(
      deps,
      deps.tenants.list().map((tenant) => tenant.id),
      body.force
    );
    if (blocked) return blocked;
  }
  const next = deps.configStore.rotatePassword({
    passwordHash,
    kick: mode === 'kick',
    now: deps.now(),
  });
  if (mode === 'kick') deps.uplink.enforceMinTokenEpoch(next.minTokenEpoch);
  return relayJson({ ok: true, passwordEpoch: next.passwordEpoch });
}

/** `{ defaultQuota }` 与 `{ limits }` 各自可选，但至少要给一个——空 PATCH 是调用方写错了。 */
export async function handleRelayConfigPatch(
  deps: RelayAdminDeps,
  req: Request
): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body) return relayError(RelayErrorCode.invalidBody, 400);
  const wantsQuota = 'defaultQuota' in body;
  const wantsLimits = 'limits' in body;
  if (!wantsQuota && !wantsLimits) return relayError(RelayErrorCode.invalidBody, 400);
  const quota = wantsQuota ? normalizeRelayQuota(body.defaultQuota) : null;
  if (wantsQuota && !quota) return relayError(RelayErrorCode.badQuota, 400);
  const limits = wantsLimits ? normalizeRelayLimits(body.limits) : null;
  if (wantsLimits && !limits) return relayError(RelayErrorCode.badLimits, 400);
  const now = deps.now();
  if (limits) {
    deps.configStore.setLimits(limits, now);
    deps.uplink.applyLimits(limits);
  }
  if (quota) {
    deps.configStore.setDefaultQuota(quota, now);
    for (const tenant of deps.tenants.list()) {
      if (tenant.quota === null) deps.uplink.notifyQuota(tenant.id);
    }
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

export async function handleRelayTenantKick(
  deps: RelayAdminDeps,
  req: Request,
  tenantId: string
): Promise<Response> {
  if (!deps.tenants.get(tenantId)) return relayError(RelayErrorCode.tenantNotFound, 404);
  const body = req.body === null ? {} : await readJsonObjectBody(req);
  if (!body || ('force' in body && typeof body.force !== 'boolean')) {
    return relayError(RelayErrorCode.invalidBody, 400);
  }
  const blocked = offlineMembersGuard(deps, [tenantId], body.force);
  if (blocked) return blocked;
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
