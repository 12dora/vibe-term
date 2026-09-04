import { isStandaloneRoles } from '../lib/roles';
import { jsonErr, jsonOk, mapError, readJsonBody } from './http';
import { becomeRelay } from './relay-setup-service';
import { type SetupServiceDeps, becomeHub, joinHub, precheckHubUrl } from './setup-service';

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

export async function handleSetupRequest(
  req: Request,
  deps: SetupServiceDeps
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (
    path !== '/api/setup/precheck' &&
    path !== '/api/setup/hub' &&
    path !== '/api/setup/join' &&
    path !== '/api/setup/relay'
  ) {
    return null;
  }
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
    if (path === '/api/setup/precheck') {
      const result = await precheckHubUrl(readString(body, 'url'), deps);
      return jsonOk(result);
    }
    if (path === '/api/setup/hub') {
      const result = await becomeHub(
        {
          hubPublicUrl: readString(body, 'hubPublicUrl'),
          username: readString(body, 'username'),
          password: readString(body, 'password'),
          directEnable: body.directEnable === true,
        },
        deps
      );
      return jsonOk(result);
    }
    if (path === '/api/setup/relay') {
      const relayPassword = body.relayPassword;
      const result = await becomeRelay(
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
      );
      return jsonOk(result);
    }
    const result = await joinHub(
      {
        hubUrl: readString(body, 'hubUrl'),
        token: readString(body, 'token'),
        name: readString(body, 'name'),
        directEnable: body.directEnable === true,
        insecureLocal: body.insecureLocal === true,
      },
      deps
    );
    return jsonOk(result);
  } catch (error) {
    return mapError(error);
  }
}
