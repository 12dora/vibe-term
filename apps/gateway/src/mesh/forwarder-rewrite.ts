import { parseNodePrefix } from './forwarder-path';
import { MESH_VIA_SELF, getMeshRequestContext, setMeshRequestContext } from './mesh-deps';

export function getSelfRewrite(req: Request): string | null {
  return getMeshRequestContext(req).selfRewrite ?? null;
}

export function rewriteSelf(req: Request, localNodeId: string): Request | null {
  const url = new URL(req.url);
  const parsed = parseNodePrefix(url.pathname);
  if (!parsed) return null;
  if (parsed.nodeId !== MESH_VIA_SELF && parsed.nodeId !== localNodeId) return null;
  return rewriteRequest(req, parsed.rest + url.search);
}

export function rewriteRequest(req: Request, rewrite: string): Request {
  const url = new URL(req.url);
  const q = rewrite.indexOf('?');
  url.pathname = q === -1 ? rewrite : rewrite.slice(0, q);
  url.search = q === -1 ? '' : rewrite.slice(q);
  const inner = new Request(url, req);
  setMeshRequestContext(inner, {
    ...getMeshRequestContext(req),
    via: MESH_VIA_SELF,
    selfRewrite: undefined,
  });
  return inner;
}
