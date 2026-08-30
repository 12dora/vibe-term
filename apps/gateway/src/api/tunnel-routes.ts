import type { TunnelActionRequest } from '@tmex/shared';
import { TunnelError, tunnelErrorFrom, tunnelHttpStatus } from '../tunnel/errors';
import { normalizeTunnelHostname } from '../tunnel/hostname';
import { type TunnelManager, tunnelManager } from '../tunnel/manager';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, route } from './route';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
      const tunnelName = typeof body.tunnelName === 'string' ? body.tunnelName : undefined;
      return { action: 'create', hostname, ...(tunnelName !== undefined ? { tunnelName } : {}) };
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
      handler: () => json(manager.status()),
    }),
    route({
      method: 'POST',
      path: '/api/tunnel/actions',
      handler: async (req) => {
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
