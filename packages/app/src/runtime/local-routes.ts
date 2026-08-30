import type { AuthenticateResult } from '../../../../apps/gateway/src/mesh/session-middleware';
import type { TlsMode } from '../../../../apps/gateway/src/tls/types';
import { isStandaloneRoles } from '../lib/roles';
import { jsonErr, jsonOk, mapError, readJsonBody } from './http';
import { type MeshRoleName, leaveMesh } from './membership-reset';
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

export type LocalRouteDeps = SetupServiceDeps & {
  authenticate: (req: Request) => AuthenticateResult;
  tlsStatus: () => Promise<LocalTlsStatus>;
};

function isMeshRoleName(value: unknown): value is MeshRoleName {
  return value === 'node' || value === 'hub,node';
}

async function handleLeave(req: Request, deps: LocalRouteDeps): Promise<Response> {
  if (isStandaloneRoles(deps.roles)) {
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
  if (!isMeshRoleName(expectedRole)) {
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

  if (!isStandaloneRoles(deps.roles)) {
    const auth = deps.authenticate(req);
    if (!auth.ok) {
      return jsonErr('UNAUTHORIZED', 'login required', 401);
    }
  }

  if (path === '/api/local/status') {
    if (req.method !== 'GET') {
      return jsonErr('method_not_allowed', 'GET required', 405);
    }
    try {
      const status: LocalStatus = await getLocalStatus(deps);
      const tls = await deps.tlsStatus();
      return jsonOk({
        ...status,
        tls: {
          mode: tls.mode,
          listenerRunning: tls.listenerRunning,
          tlsPort: tls.tlsPort,
        },
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
