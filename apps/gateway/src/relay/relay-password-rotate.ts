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

/** 改口令核心：哈希、kick 离线守卫、epoch、踢链路。admin 与租户 rotate 共用。 */
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

export function readRotateNext(next: unknown): string | null | undefined {
  if (next === null) return null;
  if (typeof next !== 'string') return undefined;
  return next === '' ? null : next;
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
  next: string | null;
  mode: 'keep' | 'kick';
  force?: boolean;
};

function parseTenantRotateBody(body: Record<string, unknown> | null): TenantRotateBody | null {
  if (!body || typeof body.tenantId !== 'string' || !body.tenantId) return null;
  const current = readOptionalString(body, 'current');
  if (current === false) return null;
  if (!('next' in body)) return null;
  const next = readRotateNext(body.next);
  const mode = readRotateMode(body.mode);
  if (next === undefined || !mode) return null;
  if ('force' in body && typeof body.force !== 'boolean') return null;
  return {
    tenantId: body.tenantId,
    current: current ?? '',
    next,
    mode,
    ...(body.force === true ? { force: true } : {}),
  };
}

async function currentPasswordMatches(
  passwordHash: string | null,
  current: string
): Promise<boolean> {
  if (!passwordHash) return current.length === 0;
  if (!current) return false;
  return verifyRelayPassword(passwordHash, current);
}

/**
 * 租户凭令牌改全站接入口令。`current` 对得上才转；`next` 最短 8（空/null 表示清除）。
 */
export async function handleRelayPasswordRotate(
  deps: RelayPublicRoutesDeps,
  req: Request
): Promise<Response> {
  const ip = deps.clientIp(req);
  if (deps.limiter.isLimited(ip)) return relayError(RelayErrorCode.rateLimited, 429);
  const parsed = parseTenantRotateBody(await readJsonObjectBody(req));
  if (!parsed) return relayError(RelayErrorCode.invalidBody, 400);
  const tenant = authenticateRelayTenant(deps, req, parsed.tenantId);
  if (tenant instanceof Response) return tenant;
  if (typeof parsed.next === 'string' && relayPasswordTooShort(parsed.next)) {
    return relayError(RelayErrorCode.enrollPasswordTooShort, 400);
  }
  const config = deps.configStore.ensure(deps.now());
  if (!(await currentPasswordMatches(config.passwordHash, parsed.current))) {
    deps.limiter.recordFailure(ip);
    return relayError(RelayErrorCode.enrollPasswordInvalid, 401);
  }
  deps.limiter.reset(ip);
  return applyRelayPasswordRotation(deps, {
    next: parsed.next,
    mode: parsed.mode,
    force: parsed.force,
  });
}
