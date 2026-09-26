import {
  LocalAuthStore,
  buildLocalAuthStatus,
} from '../../../../apps/gateway/src/db/local-auth-settings';
import { requestIsStrictLoopback } from '../../../../apps/gateway/src/mesh/client-ip';
import type { AuthenticateResult } from '../../../../apps/gateway/src/mesh/session-middleware';
import { isStandaloneRoles } from '../lib/roles';
import { jsonErr, jsonOk, mapError, readJsonBody } from './http';
import { handleRelayJoinRequest } from './relay-join-routes';
import { becomeRelay } from './relay-setup-service';
import { type SetupServiceDeps, precheckRelayUrl } from './setup-service';
import { SetupError } from './setup-shared';

const SETUP_PATHS = new Set(['/api/setup/precheck', '/api/setup/relay', '/api/setup/relay-join']);

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

/** 缺省 relay；非法值直接拒，别让打错的 kind 静默按错误判据探测。 */
function assertRelayPrecheckKind(body: Record<string, unknown>): void {
  const kind = body.kind;
  if (kind === undefined || kind === null || kind === '') return;
  if (kind !== 'relay') {
    throw new SetupError('invalid_body', "kind must be 'relay'", 400);
  }
}

async function dispatchSetupAction(
  path: string,
  body: Record<string, unknown>,
  deps: SetupServiceDeps
): Promise<Response> {
  if (path === '/api/setup/precheck') {
    assertRelayPrecheckKind(body);
    return jsonOk(await precheckRelayUrl(readString(body, 'url'), deps));
  }
  if (path === '/api/setup/relay') {
    const relayPassword = body.relayPassword;
    return jsonOk(
      await becomeRelay(
        {
          role: readString(body, 'role') as 'relay' | 'relay,node',
          relayPublicUrl: readString(body, 'relayPublicUrl'),
          relayPassword:
            relayPassword === null
              ? null
              : typeof relayPassword === 'string'
                ? relayPassword
                : undefined,
          username: readString(body, 'username'),
          password: readString(body, 'password'),
          directEnable: body.directEnable !== false,
        },
        deps
      )
    );
  }
  return await handleRelayJoinRequest(body, deps);
}

export type SetupRouteDeps = SetupServiceDeps & {
  authenticate?: (req: Request) => AuthenticateResult;
};

export async function handleSetupRequest(
  req: Request,
  deps: SetupRouteDeps
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (!SETUP_PATHS.has(path)) return null;
  if (!isStandaloneRoles(deps.roles)) {
    return jsonErr('not_standalone', 'setup is only available in standalone mode', 404);
  }
  const denied = denySetupAccess(req, deps);
  if (denied) return denied;
  if (req.method !== 'POST') {
    return jsonErr('method_not_allowed', 'POST required', 405);
  }
  const body = await readJsonBody(req);
  if (!body) {
    return jsonErr('invalid_body', 'JSON object body required', 400);
  }
  try {
    return await dispatchSetupAction(path, body, deps);
  } catch (error) {
    return mapError(error);
  }
}

function denySetupAccess(req: Request, deps: SetupRouteDeps): Response | null {
  if (setupRequiresSession(deps)) {
    const auth = deps.authenticate?.(req);
    if (auth?.ok && auth.userId) return null;
    if (auth?.ok) return strictLoopbackOrDeny(req);
    return jsonErr('UNAUTHORIZED', 'login required', 401);
  }
  return strictLoopbackOrDeny(req);
}

function strictLoopbackOrDeny(req: Request): Response | null {
  if (requestIsStrictLoopback(req)) return null;
  return jsonErr('LOOPBACK_REQUIRED', 'setup is only available on this machine', 403);
}

function setupRequiresSession(deps: SetupRouteDeps): boolean {
  if (listedUsers(deps) > 0) return true;
  return localAuthEffective(deps);
}

function localAuthEffective(deps: SetupRouteDeps): boolean {
  if (!isStandaloneRoles(deps.roles) || !deps.auth.db) return false;
  return buildLocalAuthStatus({
    standalone: true,
    enabled: new LocalAuthStore(deps.auth.db).getEnabled(),
    credentialsPresent: listedUsers(deps) > 0,
  }).effective;
}

function listedUsers(deps: SetupRouteDeps): number {
  const list = deps.auth.userStore?.listUsers;
  if (typeof list !== 'function') return 0;
  try {
    const users = list.call(deps.auth.userStore);
    return Array.isArray(users) ? users.length : 0;
  } catch {
    return 0;
  }
}
