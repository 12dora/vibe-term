import { getMeshRequestContext } from './mesh-deps';

export const X_TMEX_MESH_PEER = 'x-tmex-mesh-peer';

export function readMeshPeerMarker(req: Request): string | null {
  const raw = req.headers.get(X_TMEX_MESH_PEER)?.trim() ?? '';
  return raw || null;
}

export function attachMeshPeerMarker(
  headers: Record<string, string>,
  fromNodeId: string
): Record<string, string> {
  return { ...headers, [X_TMEX_MESH_PEER]: fromNodeId };
}

export function isPeerInboundRequest(req: Request): boolean {
  return (getMeshRequestContext(req).clientIp ?? '').startsWith('peer:');
}

export function stripMeshPeerMarkerFromRequest(req: Request): Request {
  if (!req.headers.has(X_TMEX_MESH_PEER)) {
    return req;
  }
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (key.toLowerCase() !== X_TMEX_MESH_PEER) {
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
