import { isStandaloneRoles } from '../lib/roles';
import { jsonErr, jsonOk, mapError, readJsonBody } from './http';
import { handleRelayJoinRequest } from './relay-join-routes';
import { becomeRelay } from './relay-setup-service';
import { type SetupServiceDeps, becomeHub, joinHub, precheckHubUrl } from './setup-service';
import { SetupError } from './setup-shared';

const SETUP_PATHS = new Set([
  '/api/setup/precheck',
  '/api/setup/hub',
  '/api/setup/join',
  '/api/setup/relay',
  '/api/setup/relay-join',
]);

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

const TOTP_CODE_RE = /^\d{6,10}$/;

function readOptionalTotpCode(body: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(body, 'totpCode') || body.totpCode == null || body.totpCode === '') {
    return undefined;
  }
  if (typeof body.totpCode !== 'string' || !TOTP_CODE_RE.test(body.totpCode)) {
    throw new SetupError('invalid_body', 'totpCode must be 6-10 digits', 400);
  }
  return body.totpCode;
}

async function dispatchSetupAction(
  path: string,
  body: Record<string, unknown>,
  deps: SetupServiceDeps
): Promise<Response> {
  if (path === '/api/setup/precheck') {
    return jsonOk(await precheckHubUrl(readString(body, 'url'), deps));
  }
  if (path === '/api/setup/hub') {
    return jsonOk(
      await becomeHub(
        {
          hubPublicUrl: readString(body, 'hubPublicUrl'),
          username: readString(body, 'username'),
          password: readString(body, 'password'),
          directEnable: body.directEnable === true,
        },
        deps
      )
    );
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
          directEnable: body.directEnable === true,
        },
        deps
      )
    );
  }
  if (path === '/api/setup/relay-join') {
    return await handleRelayJoinRequest(body, deps);
  }
  const method =
    body.method === 'password' ? 'password' : body.method === 'token' ? 'token' : undefined;
  return jsonOk(
    await joinHub(
      {
        hubUrl: readString(body, 'hubUrl'),
        token: readString(body, 'token') || undefined,
        password: readString(body, 'password') || undefined,
        method,
        name: readString(body, 'name'),
        directEnable: body.directEnable === true,
        insecureLocal: body.insecureLocal === true,
        totpCode: readOptionalTotpCode(body),
      },
      deps
    )
  );
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
