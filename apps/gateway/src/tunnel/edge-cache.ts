import { getGatewayKv, setGatewayKv } from '../db/kv';
import type { CachedEdge, EdgeCache } from './edge-resolver';

export const LAST_STATIC_EDGE_KEY = 'tunnel.lastStaticEdge';

const HOST_PORT_RE = /^\[?[A-Za-z0-9.:_-]+\]?:\d{1,5}$/;

export function parseCachedEdge(raw: string | null): CachedEdge | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const rec = parsed as { edgeAddrs?: unknown; resolvedAt?: unknown };
    if (!Array.isArray(rec.edgeAddrs) || typeof rec.resolvedAt !== 'string') return null;
    const edgeAddrs = rec.edgeAddrs.filter(
      (addr): addr is string => typeof addr === 'string' && HOST_PORT_RE.test(addr)
    );
    if (edgeAddrs.length === 0 || !Number.isFinite(Date.parse(rec.resolvedAt))) return null;
    return { edgeAddrs, resolvedAt: rec.resolvedAt };
  } catch {
    return null;
  }
}

/** 上次成功的静态边缘列表落在 gateway_kv：开机 DoH 失败时用它兜底。 */
export function gatewayKvEdgeCache(): EdgeCache {
  return {
    read: async () => {
      try {
        return parseCachedEdge(getGatewayKv(LAST_STATIC_EDGE_KEY));
      } catch {
        return null;
      }
    },
    write: async (value) => {
      try {
        setGatewayKv(LAST_STATIC_EDGE_KEY, JSON.stringify(value));
      } catch {}
    },
  };
}
