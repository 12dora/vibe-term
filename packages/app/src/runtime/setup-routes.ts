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

export async function handleSetupRequest(
  req: Request,
  deps: SetupServiceDeps
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (!SETUP_PATHS.has(path)) return null;
  if (!isStandaloneRoles(deps.roles)) {
    return jsonErr('not_standalone', 'setup is only available in standalone mode', 404);
  }
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
