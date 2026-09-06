import {
  MESH_PEER_HEADER,
  assignHeaderPair,
  hasHeaderPair,
  matchesHeaderPair,
  readHeaderPair,
} from '@vibeterm/shared/http/mesh-headers';
import { getMeshRequestContext } from './mesh-deps';

export { MESH_PEER_HEADER };

export function readMeshPeerMarker(req: Request): string | null {
  const raw = readHeaderPair(req.headers, MESH_PEER_HEADER)?.trim() ?? '';
  return raw || null;
}

export function attachMeshPeerMarker(
  headers: Record<string, string>,
  fromNodeId: string
): Record<string, string> {
  return assignHeaderPair({ ...headers }, MESH_PEER_HEADER, fromNodeId);
}

export function isPeerInboundRequest(req: Request): boolean {
  return (getMeshRequestContext(req).clientIp ?? '').startsWith('peer:');
}

export function stripMeshPeerMarkerFromRequest(req: Request): Request {
  if (!hasHeaderPair(req.headers, MESH_PEER_HEADER)) {
    return req;
  }
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!matchesHeaderPair(key, MESH_PEER_HEADER)) {
      headers.append(key, value);
    }
  });
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(req.url, {
    method: req.method,
    headers,
    redirect: req.redirect,
    signal: req.signal,
    ...(hasBody ? { body: req.body, duplex: 'half' as const } : {}),
  });
}
