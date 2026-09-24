import { isRecord } from './ctl';

export const PEER_MAX_ENDPOINTS = 16;
export const PEER_MAX_ENDPOINT_LENGTH = 256;

export function sanitizeEndpoints(value: unknown, fallbackPort?: number): string[] {
  if (typeof value === 'string') return parseEndpoints(value, fallbackPort);
  try {
    return parseEndpoints(JSON.stringify(value ?? []), fallbackPort);
  } catch {
    return [];
  }
}

export function parseEndpoints(endpointsJson: string, fallbackPort?: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(endpointsJson);
  } catch {
    return [];
  }
  const urls: string[] = [];
  const push = (raw: string) => {
    if (urls.length >= PEER_MAX_ENDPOINTS) return;
    if (raw.length > PEER_MAX_ENDPOINT_LENGTH) return;
    if (raw.startsWith('ws://') || raw.startsWith('wss://')) {
      urls.push(raw);
      return;
    }
    if (raw.includes('://')) return;
    const withPath = raw.includes('/peer') ? raw : `${raw}/peer`;
    const url = withPath.startsWith('ws') ? withPath : `ws://${withPath}`;
    if (url.length > PEER_MAX_ENDPOINT_LENGTH) return;
    urls.push(url);
  };
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (typeof item === 'string') {
        push(item);
      } else if (isRecord(item)) {
        if (typeof item.url === 'string') push(item.url);
        else if (typeof item.host === 'string') {
          const port = typeof item.port === 'number' ? item.port : (fallbackPort ?? 39001);
          const path = typeof item.path === 'string' ? item.path : '/peer';
          push(`ws://${item.host}:${port}${path.startsWith('/') ? path : `/${path}`}`);
        }
      }
    }
  }
  return urls;
}
