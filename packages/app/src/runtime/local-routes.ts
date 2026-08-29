import type { AuthenticateResult } from '../../../../apps/gateway/src/mesh/session-middleware';
import type { TlsMode } from '../../../../apps/gateway/src/tls/types';
import { isStandaloneRoles } from '../lib/roles';
import { jsonErr, jsonOk, readJsonBody } from './http';
import {
  type DirectSetResult,
  type LocalStatus,
  SetupError,
  type SetupServiceDeps,
} from './setup-service';
import { getLocalStatus, setLocalDirect } from './setup-service';

export type LocalTlsStatus = {
  mode: TlsMode;
  listenerRunning: boolean;
  tlsPort: number;
};

export type LocalRouteDeps = SetupServiceDeps & {
  authenticate: (req: Request) => AuthenticateResult;
  tlsStatus: () => Promise<LocalTlsStatus>;
};

function mapError(error: unknown): Response {
  if (error instanceof SetupError) {
    return jsonErr(error.code, error.message, error.httpStatus);
  }
  const message = error instanceof Error ? error.message : String(error);
  return jsonErr('direct_failed', message, 500);
}

export async function handleLocalRequest(
  req: Request,
  deps: LocalRouteDeps
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
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
      return mapError(error);
    }
  }

  if (req.method !== 'POST') {
    return jsonErr('method_not_allowed', 'POST required', 405);
  }
  const body = await readJsonBody(req);
  if (!body || typeof body.enable !== 'boolean') {
    return jsonErr('invalid_body', 'body must include boolean enable', 400);
  }
  try {
    const result: DirectSetResult = await setLocalDirect(body.enable, deps);
    return jsonOk(result);
  } catch (error) {
    return mapError(error);
  }
}
