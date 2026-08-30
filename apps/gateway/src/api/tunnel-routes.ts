import type { TunnelActionRequest } from '@tmex/shared';
import { MESH_VIA_SELF, getMeshRequestContext, requestDispatchContext } from '../mesh/mesh-deps';
import { isPeerInboundRequest } from '../mesh/peer-request-marker';
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

function parseAction(body: Record<string, unknown>): TunnelActionRequest {
  const action = body.action;
  switch (action) {
    case 'install':
    case 'login':
    case 'cancel_login':
    case 'quick_start':
    case 'start':
    case 'stop':
    case 'remove':
    case 'check':
      return { action };
    case 'create': {
      if (typeof body.hostname !== 'string') {
        throw new TunnelError('invalid_request', 'hostname is required');
      }
      const hostname = normalizeTunnelHostname(body.hostname);
      if (!hostname) {
        throw new TunnelError('invalid_hostname', 'hostname is not a valid RFC 1123 name');
      }
      if (typeof body.tunnelName === 'string' && body.tunnelName.trim()) {
        const tunnelName = normalizeTunnelName(body.tunnelName);
        if (!tunnelName) {
          throw new TunnelError('invalid_request', 'tunnel name is not a valid identifier');
        }
        return { action: 'create', hostname, tunnelName };
      }
      return { action: 'create', hostname };
    }
    case 'set_auto_start':
      if (typeof body.autoStart !== 'boolean') {
        throw new TunnelError('invalid_request', 'autoStart must be a boolean');
      }
      return { action: 'set_auto_start', autoStart: body.autoStart };
    case 'set_trust_proxy':
      if (typeof body.trustProxy !== 'boolean') {
        throw new TunnelError('invalid_request', 'trustProxy must be a boolean');
      }
      return { action: 'set_trust_proxy', trustProxy: body.trustProxy };
    default:
      throw new TunnelError('invalid_request', 'unknown action');
  }
}

export function createTunnelRoutes(manager: TunnelManager = tunnelManager): ApiRoute[] {
  return [
    route({
      method: 'GET',
      path: '/api/tunnel/status',
      handler: (req, _params, ctx) => {
        const blocked = rejectIfForwarded(req, ctx);
        if (blocked) return blocked;
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
