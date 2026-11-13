import { readJsonObjectBody } from '@vibeterm/shared/http';
import type { RelayConfigStore } from './relay-config-store';
import { RelayErrorCode, relayError, relayJson } from './relay-http';
import { hashRelayPassword, relayPasswordTooShort, verifyRelayPassword } from './relay-password';
import type { RelayRegistry } from './relay-registry';
import { type RelayPublicRoutesDeps, authenticateRelayTenant } from './relay-routes';
import type { RelayTenantStore } from './relay-tenant-store';
import type { RelayUplinkServer } from './relay-uplink-server';

export type RelayPasswordRotateCoreDeps = {
  tenants: RelayTenantStore;
  configStore: RelayConfigStore;
  registry: RelayRegistry;
  uplink: RelayUplinkServer;
  now: () => number;
};

export type RelayPasswordRotateInput = {
  next: string | null;
  mode: 'keep' | 'kick';
  force?: unknown;
};

export function offlineMembersGuard(
  deps: RelayPasswordRotateCoreDeps,
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

/** 运营者改口令：可清除口令；kick 抬全局 `minTokenEpoch`，作废全部租户的旧令牌。 */
export async function applyRelayPasswordRotation(
  deps: RelayPasswordRotateCoreDeps,
  input: RelayPasswordRotateInput
): Promise<Response> {
  if (input.mode === 'kick') {
    const blocked = offlineMembersGuard(
      deps,
      deps.tenants.list().map((tenant) => tenant.id),
      input.force
    );
    if (blocked) return blocked;
  }
  const passwordHash = input.next === null ? null : await hashRelayPassword(input.next);
  const next = deps.configStore.rotatePassword({
    passwordHash,
    kick: input.mode === 'kick',
    now: deps.now(),
  });
  if (input.mode === 'kick') deps.uplink.enforceMinTokenEpoch(next.minTokenEpoch);
  return relayJson({ ok: true, passwordEpoch: next.passwordEpoch });
}

export function readRotateMode(mode: unknown): 'keep' | 'kick' | null {
  if (mode === undefined || mode === 'keep') return 'keep';
  if (mode === 'kick') return 'kick';
  return null;
}

/** 租户侧只能换成新口令，清除口令只走运营者路由。 */
export function readRotateNext(next: unknown): string | undefined {
  return typeof next === 'string' && next !== '' ? next : undefined;
}

function readOptionalString(
  body: Record<string, unknown>,
  key: string
): string | undefined | false {
  if (!(key in body) || body[key] === undefined) return undefined;
  return typeof body[key] === 'string' ? body[key] : false;
}

type TenantRotateBody = {
  tenantId: string;
  current: string;
  next: string;
  mode: 'keep' | 'kick';
};

function parseTenantRotateBody(body: Record<string, unknown> | null): TenantRotateBody | null {
  if (!body || typeof body.tenantId !== 'string' || !body.tenantId) return null;
  const current = readOptionalString(body, 'current');
  if (current === false) return null;
  const next = readRotateNext(body.next);
  const mode = readRotateMode(body.mode);
  if (next === undefined || !mode) return null;
  return {
    tenantId: body.tenantId,
    current: current ?? '',
    next,
    mode,
  };
}

async function currentPasswordMatches(
  deps: RelayPublicRoutesDeps,
  ip: string,
  passwordHash: string,
  current: string
): Promise<boolean | Response> {
  if (current.length === 0) {
    deps.limiter.recordFailure(ip);
    return false;
  }
  const slot = deps.limiter.reserveKdf(ip);
  if (!slot.ok) {
    return relayError(RelayErrorCode.rateLimited, 429, { retryAfterMs: slot.retryAfterMs });
  }
  let ok = false;
  try {
    ok = await verifyRelayPassword(passwordHash, current);
  } finally {
    slot.done(ok);
  }
  return ok;
}

/**
 * 租户改口令只推进 `passwordEpoch`，不动全局 `minTokenEpoch`，其它租户的令牌照旧有效。
 * kick 只作废调用租户自己：置 `kicked`、清历史令牌、断其链路，须用新口令重新 enroll（`recover`）。
 */
async function applyTenantPasswordRotation(
  deps: RelayPasswordRotateCoreDeps,
  tenantId: string,
  input: { next: string; mode: 'keep' | 'kick' }
): Promise<Response> {
  if (input.mode === 'kick') {
    const blocked = offlineMembersGuard(deps, [tenantId], false);
    if (blocked) return blocked;
  }
  const next = deps.configStore.rotatePassword({
    passwordHash: await hashRelayPassword(input.next),
    kick: false,
    now: deps.now(),
  });
  if (input.mode === 'kick') {
    deps.tenants.setKicked(tenantId, true);
    deps.uplink.kickTenant(tenantId, 'password_rotated');
  }
  return relayJson({ ok: true, passwordEpoch: next.passwordEpoch });
}

/** 租户凭令牌改全站接入口令。`current` 对得上才转；`next` 必须是至少 8 位的新口令。 */
export async function handleRelayPasswordRotate(
  deps: RelayPublicRoutesDeps,
  req: Request
): Promise<Response> {
  const ip = deps.clientIp(req);
  if (deps.limiter.isLimited(ip)) {
    return relayError(RelayErrorCode.rateLimited, 429, {
      retryAfterMs: deps.limiter.retryAfterMs(ip),
    });
  }
  const parsed = parseTenantRotateBody(await readJsonObjectBody(req));
  if (!parsed) return relayError(RelayErrorCode.invalidBody, 400);
  const tenant = authenticateRelayTenant(deps, req, parsed.tenantId);
  if (tenant instanceof Response) return tenant;
  if (relayPasswordTooShort(parsed.next)) {
    return relayError(RelayErrorCode.enrollPasswordTooShort, 400);
  }
  const config = deps.configStore.ensure(deps.now());
  if (config.passwordHash === null) {
    return relayError(RelayErrorCode.enrollPasswordUnset, 409, {
      message: 'the relay has no access password; the operator sets the first one',
    });
  }
  const matches = await currentPasswordMatches(deps, ip, config.passwordHash, parsed.current);
  if (matches instanceof Response) return matches;
  if (!matches) return relayError(RelayErrorCode.enrollPasswordInvalid, 401);
  return applyTenantPasswordRotation(deps, tenant.id, {
    next: parsed.next,
    mode: parsed.mode,
  });
}
