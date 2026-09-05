import type { TunnelAccessMode, TunnelActionRequest } from '@tmex/shared';
import { MESH_VIA_SELF, getMeshRequestContext, requestDispatchContext } from '../mesh/mesh-deps';
import { isPeerInboundRequest } from '../mesh/peer-request-marker';
import { parseAccessRules } from '../tunnel/access-rules';
import { TunnelError, tunnelErrorFrom, tunnelHttpStatus } from '../tunnel/errors';
import { normalizeTunnelHostname, normalizeTunnelName } from '../tunnel/hostname';
import { type TunnelManager, tunnelManager } from '../tunnel/manager';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, type ApiRouteContext, route } from './route';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isForwardedTunnelRequest(req: Request, ctx: ApiRouteContext): boolean {
  if (isPeerInboundRequest(req)) return true;
  const mesh = ctx.mesh ?? requestDispatchContext.get(req);
  if (mesh && mesh.viaNodeId !== MESH_VIA_SELF) return true;
  const via = getMeshRequestContext(req).via;
  return via !== MESH_VIA_SELF;
}

function rejectIfForwarded(req: Request, ctx: ApiRouteContext): Response | null {
  if (!isForwardedTunnelRequest(req, ctx)) return null;
  return new Response(null, { status: 404 });
}

function optionalHostname(body: Record<string, unknown>): string | undefined {
  if (body.hostname === undefined) return undefined;
  if (typeof body.hostname !== 'string') {
    throw new TunnelError('invalid_request', 'hostname must be a string');
  }
  const hostname = normalizeTunnelHostname(body.hostname);
  if (!hostname) {
    throw new TunnelError('invalid_hostname', 'hostname is not a valid RFC 1123 name');
  }
  return hostname;
}

function optionalAck(body: Record<string, unknown>): boolean | undefined {
  if (body.acknowledgeExposure === undefined) return undefined;
  if (typeof body.acknowledgeExposure !== 'boolean') {
    throw new TunnelError('invalid_request', 'acknowledgeExposure must be a boolean');
  }
  return body.acknowledgeExposure;
}

function parseAccessMode(value: unknown): TunnelAccessMode {
  if (value === 'none' || value === 'login' || value === 'cloudflare') return value;
  throw new TunnelError('invalid_request', 'accessMode must be none, login, or cloudflare');
}

function withAck<T extends TunnelActionRequest>(base: T, body: Record<string, unknown>): T {
  const acknowledgeExposure = optionalAck(body);
  return acknowledgeExposure === undefined ? base : { ...base, acknowledgeExposure };
}

function requiredBool(body: Record<string, unknown>, key: string, message: string): boolean {
  const value = body[key];
  if (typeof value !== 'boolean') throw new TunnelError('invalid_request', message);
  return value;
}

function requiredHostname(body: Record<string, unknown>): string {
  if (typeof body.hostname !== 'string') {
    throw new TunnelError('invalid_request', 'hostname is required');
  }
  const hostname = normalizeTunnelHostname(body.hostname);
  if (!hostname) {
    throw new TunnelError('invalid_hostname', 'hostname is not a valid RFC 1123 name');
  }
  return hostname;
}

function parseAccessCredentials(body: Record<string, unknown>): TunnelActionRequest {
  if (typeof body.apiToken !== 'string' || typeof body.accountId !== 'string') {
    throw new TunnelError('invalid_request', 'apiToken and accountId are required');
  }
  return { action: 'set_access_credentials', apiToken: body.apiToken, accountId: body.accountId };
}

function parseConfigureAccess(body: Record<string, unknown>): TunnelActionRequest {
  if (!Array.isArray(body.rules)) {
    throw new TunnelError('invalid_request', 'rules must be an array');
  }
  const hostname = optionalHostname(body);
  return {
    action: 'configure_access',
    rules: parseAccessRules(body.rules),
    ...(hostname === undefined ? {} : { hostname }),
  };
}

function parseAccessAction(body: Record<string, unknown>): TunnelActionRequest | null {
  switch (body.action) {
    case 'remove_access':
      return withAck({ action: 'remove_access' }, body);
    case 'sync_access': {
      const hostname = optionalHostname(body);
      return hostname === undefined
        ? { action: 'sync_access' }
        : { action: 'sync_access', hostname };
    }
    case 'set_access_credentials':
      return parseAccessCredentials(body);
    case 'configure_access':
      return parseConfigureAccess(body);
    case 'set_access_enforce':
      return withAck(
        {
          action: 'set_access_enforce',
          enforceJwt: requiredBool(body, 'enforceJwt', 'enforceJwt must be a boolean'),
        },
        body
      );
    case 'set_access_mode':
      return withAck(
        { action: 'set_access_mode', accessMode: parseAccessMode(body.accessMode) },
        body
      );
    default:
      return null;
  }
}

function parseCreateAction(body: Record<string, unknown>): TunnelActionRequest {
  const base = withAck({ action: 'create', hostname: requiredHostname(body) }, body);
  if (typeof body.tunnelName !== 'string' || !body.tunnelName.trim()) return base;
  const tunnelName = normalizeTunnelName(body.tunnelName);
  if (!tunnelName) {
    throw new TunnelError('invalid_request', 'tunnel name is not a valid identifier');
  }
  return { ...base, tunnelName };
}

function parseAction(body: Record<string, unknown>): TunnelActionRequest {
  const access = parseAccessAction(body);
  if (access) return access;
  const action = body.action;
  switch (action) {
    case 'install':
    case 'login':
    case 'cancel_login':
    case 'stop':
    case 'remove':
    case 'check':
    case 'clear_access_credentials':
      return { action };
    case 'quick_start':
    case 'start':
      return withAck({ action }, body);
    case 'create':
      return parseCreateAction(body);
    case 'set_auto_start':
      return withAck(
        {
          action: 'set_auto_start',
          autoStart: requiredBool(body, 'autoStart', 'autoStart must be a boolean'),
        },
        body
      );
    case 'set_trust_proxy':
      return {
        action: 'set_trust_proxy',
        trustProxy: requiredBool(body, 'trustProxy', 'trustProxy must be a boolean'),
      };
    case 'adopt_external':
      return { action: 'adopt_external', hostname: requiredHostname(body) };
    default:
      throw new TunnelError('invalid_request', 'unknown action');
  }
}

export function createTunnelRoutes(manager: TunnelManager = tunnelManager): ApiRoute[] {
  return [
    route({
      method: 'GET',
      path: '/api/tunnel/status',
      handler: async (req, _params, ctx) => {
        const blocked = rejectIfForwarded(req, ctx);
        if (blocked) return blocked;
        await manager.refreshExternal();
        await manager.ensureFreshConnector({ maxWaitMs: 800 });
        return json(manager.status());
      },
    }),
    route({
      method: 'POST',
      path: '/api/tunnel/actions',
      handler: async (req, _params, ctx) => {
        const blocked = rejectIfForwarded(req, ctx);
        if (blocked) return blocked;
        const raw = await readJsonObjectBody(req);
        if (!raw || !isRecord(raw)) {
          const error = tunnelErrorFrom(
            new TunnelError('invalid_request', 'request body must be a JSON object')
          );
          return json({ error }, tunnelHttpStatus(error.code));
        }
        try {
          const parsed = parseAction(raw);
          const result = await manager.handleAction(parsed);
          return json(result.payload, result.httpStatus);
        } catch (error) {
          const parsed = tunnelErrorFrom(error);
          return json({ error: parsed }, tunnelHttpStatus(parsed.code));
        }
      },
    }),
  ];
}

export const tunnelRoutes = createTunnelRoutes();
