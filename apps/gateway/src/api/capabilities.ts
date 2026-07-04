import { wsBorsh } from '@tmex/shared';
import { API_VERSION, GATEWAY_CAPABILITIES } from '../capabilities';
import { getDisplayVersion } from '../system/version';

export function handleCapabilitiesApiRequest(req: Request, path: string): Response | null {
  if (path === '/api/capabilities' && req.method === 'GET') {
    return handleGetCapabilities();
  }
  return null;
}

function handleGetCapabilities(): Response {
  return new Response(
    JSON.stringify({
      serverImpl: 'tmex-gateway',
      serverVersion: getDisplayVersion(),
      apiVersion: API_VERSION,
      wsProtocolVersion: wsBorsh.CURRENT_VERSION,
      capabilities: [...GATEWAY_CAPABILITIES],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
