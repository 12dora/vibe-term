import { canonicalPeerHost, isIpv4DottedLiteral, parseIpv6Words } from './address-class';
import { isRecord } from './ctl';

export const PEER_MAX_ENDPOINTS = 16;
export const PEER_MAX_ENDPOINT_LENGTH = 256;
/** Gateway `PeerServer` 只升级这条路径。 */
export const PEER_WS_PATH = '/peer';

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
    const url = normalizePeerEndpoint(raw);
    if (!url || urls.includes(url)) return;
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
          const path = typeof item.path === 'string' ? item.path : PEER_WS_PATH;
          push(`ws://${item.host}:${port}${path.startsWith('/') ? path : `/${path}`}`);
        }
      }
    }
  }
  return urls;
}

function normalizePeerEndpoint(raw: string): string | null {
  let candidate = raw;
  if (!candidate.startsWith('ws://') && !candidate.startsWith('wss://')) {
    if (candidate.includes('://')) return null;
    const withPath = candidate.includes(PEER_WS_PATH) ? candidate : `${candidate}${PEER_WS_PATH}`;
    candidate = withPath.startsWith('ws') ? withPath : `ws://${withPath}`;
  }
  if (candidate.length > PEER_MAX_ENDPOINT_LENGTH) return null;
  return isAllowedPeerEndpoint(candidate) ? candidate : null;
}

export function isAllowedPeerEndpoint(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return false;
  if (parsed.pathname !== PEER_WS_PATH) return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.search || parsed.hash) return false;
  if (parsed.port === '0') return false;
  const host = canonicalPeerHost(parsed.hostname) ?? parsed.hostname.trim().toLowerCase();
  if (!host) return false;
  return !isDroppedPeerEndpointHost(host);
}

function isDroppedPeerEndpointHost(host: string): boolean {
  const mapped = canonicalPeerHost(host) ?? host;
  if (isUnspecifiedHost(mapped)) return true;
  if (isLinkLocalHost(mapped)) return true;
  if (isMulticastHost(mapped)) return true;
  return false;
}

function isUnspecifiedHost(host: string): boolean {
  if (host === '::' || host === '0.0.0.0') return true;
  if (isIpv4DottedLiteral(host)) {
    return host.split('.').every((part) => Number(part) === 0);
  }
  const words = parseIpv6Words(host);
  return words?.every((word) => word === 0) ?? false;
}

function isLinkLocalHost(host: string): boolean {
  if (isIpv4DottedLiteral(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 169 && b === 254;
  }
  const words = parseIpv6Words(host);
  if (!words) return false;
  return ((words[0] ?? 0) & 0xffc0) === 0xfe80;
}

function isMulticastHost(host: string): boolean {
  if (isIpv4DottedLiteral(host)) {
    const a = Number(host.split('.')[0]);
    return a >= 224 && a <= 239;
  }
  const words = parseIpv6Words(host);
  if (!words) return false;
  return ((words[0] ?? 0) & 0xff00) === 0xff00;
}
