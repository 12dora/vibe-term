import type { AuthenticateResult } from '../../../../apps/gateway/src/mesh/session-middleware';
import type { TlsMode } from '../../../../apps/gateway/src/tls/types';
import { jsonErr, jsonOk, mapError, readJsonBody } from './http';
import { isLeavableRoleName, leaveMesh } from './membership-reset';
import {
  type DirectSetResult,
  type LocalStatus,
  type SetupServiceDeps,
  getLocalStatus,
  setLocalDirect,
} from './setup-service';

export type LocalTlsStatus = {
  mode: TlsMode;
  listenerRunning: boolean;
  tlsPort: number;
};

export type DomainAccessStatus = {
  allowed: boolean;
  viaDomain: boolean;
  hosts: string[];
};

export type LocalRouteDeps = SetupServiceDeps & {
  authenticate: (req: Request) => AuthenticateResult;
  tlsStatus: () => Promise<LocalTlsStatus>;
  domainAccess?: (req: Request) => DomainAccessStatus;
};

function defaultDomainAccess(): DomainAccessStatus {
  return { allowed: true, viaDomain: false, hosts: [] };
}

async function handleLeave(req: Request, deps: LocalRouteDeps): Promise<Response> {
  // 纯 relay 只替别的租户转发，本机没有用户/证书/密钥日志，没有可退的成员身份
  if (!deps.roles.node) {
    return jsonErr('not_member', 'not a mesh member', 400);
  }
  const auth = deps.authenticate(req);
  if (!auth.ok) {
    return jsonErr('unauthorized', 'login required', 401);
  }
  if (req.method !== 'POST') {
    return jsonErr('method_not_allowed', 'POST required', 405);
  }
  const body = await readJsonBody(req);
  const expectedRole = body?.expectedRole;
  if (!isLeavableRoleName(expectedRole)) {
    return jsonErr('role_mismatch', 'expectedRole must match current role', 409);
  }
  try {
    const result = await leaveMesh({ expectedRole }, deps);
    return jsonOk(result);
  } catch (error) {
    return mapError(error, 'leave_failed');
  }
}

export async function handleLocalRequest(
  req: Request,
  deps: LocalRouteDeps
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (path === '/api/local/leave') {
    return handleLeave(req, deps);
  }
  if (path !== '/api/local/status' && path !== '/api/local/direct') return null;

  const auth = deps.authenticate(req);
  if (!auth.ok) {
    return jsonErr('UNAUTHORIZED', 'login required', 401);
  }

  if (path === '/api/local/status') {
    if (req.method !== 'GET') {
      return jsonErr('method_not_allowed', 'GET required', 405);
    }
    try {
      const [status, tls]: [LocalStatus, LocalTlsStatus] = await Promise.all([
        getLocalStatus(deps),
        deps.tlsStatus(),
      ]);
      return jsonOk({
        ...status,
        tls: {
          mode: tls.mode,
          listenerRunning: tls.listenerRunning,
          tlsPort: tls.tlsPort,
        },
        domainAccess: (deps.domainAccess ?? defaultDomainAccess)(req),
      });
    } catch (error) {
      return mapError(error, 'direct_failed');
    }
  }

  if (req.method !== 'POST') {
    return jsonErr('method_not_allowed', 'POST required', 405);
  }
  const body = await readJsonBody(req);
  const action = body?.action;
  if (action !== 'install' && action !== 'remove' && action !== 'enable' && action !== 'disable') {
    return jsonErr('invalid_action', 'action must be install, remove, enable, or disable', 400);
  }
  try {
    const result: DirectSetResult = await setLocalDirect(action, deps);
    return jsonOk(result);
  } catch (error) {
    return mapError(error, 'direct_failed');
  }
}
