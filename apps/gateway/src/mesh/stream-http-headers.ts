import { VIA_HEADER, addHeaderNames } from '@vibeterm/shared/http/mesh-headers';
import { isRecord } from './ctl';
import { MESH_PEER_HEADER } from './peer-request-marker';

const BLOCKED_REQUEST_HEADERS = addHeaderNames(
  new Set(['cookie', 'authorization', 'host', 'connection', 'upgrade']),
  VIA_HEADER,
  MESH_PEER_HEADER
);

export function stripForwardedRequestHeaders(
  headers?: Record<string, string> | null
): Record<string, string> {
  return copyHeaders(
    headers,
    (k) => BLOCKED_REQUEST_HEADERS.has(k) || k.startsWith('proxy-') || k.startsWith('x-forwarded-')
  );
}

export function stripSetCookieHeaders(headers: Record<string, string>): Record<string, string> {
  return copyHeaders(headers, (k) => k === 'set-cookie');
}

export function copyHeaders(
  headers: Record<string, string> | null | undefined,
  drop: (lower: string) => boolean
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (!drop(key.toLowerCase())) out[key] = value;
  }
  return out;
}

export function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return stripSetCookieHeaders(out);
}

export function stringHeaders(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string') out[key] = val;
  }
  return out;
}
