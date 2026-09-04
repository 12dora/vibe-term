import {
  classifyRemoteAddress,
  isCgnatIpv4,
  isIpAddressLiteral,
  isLoopbackHostLiteral,
  looksLikeIpv6,
} from './address-class';
import { resolveClientIp } from './client-ip';

const DEFAULT_PORTS = new Set(['80', '443']);

export type DomainAccessDecision = 'allow' | 'deny-json' | 'deny-text';

export function isLocalClientSource(ip: string | null | undefined): boolean {
  if (!ip) return false;
  if (classifyRemoteAddress(ip) === 'lan') return true;
  return isCgnatIpv4(ip);
}

export function normalizeHost(authority: string): string {
  const raw = authority.trim().toLowerCase();
  if (!raw) return '';
  const parsed = splitHostPort(raw);
  if (!parsed) return '';
  let hostname = stripBrackets(parsed.hostname).replace(/\.+$/, '');
  const zone = hostname.indexOf('%');
  if (zone >= 0) hostname = hostname.slice(0, zone);
  if (!hostname) return '';
  const port = parsed.port && !DEFAULT_PORTS.has(parsed.port) ? parsed.port : null;
  if (looksLikeIpv6(hostname)) {
    return port ? `[${hostname}]:${port}` : hostname;
  }
  return port ? `${hostname}:${port}` : hostname;
}

export function isIpLiteral(host: string): boolean {
  const hostname = stripBrackets(hostnameOf(normalizeHost(host) || host.toLowerCase()));
  if (!hostname) return false;
  return isIpAddressLiteral(hostname);
}

export function isLocalName(host: string): boolean {
  const hostname = stripBrackets(hostnameOf(normalizeHost(host) || host.toLowerCase()));
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === 'local' || hostname.endsWith('.local')) return true;
  return isLoopbackHostLiteral(hostname);
}

export function collectConfiguredHosts(sources: Iterable<string | null | undefined>): string[] {
  const hosts = new Set<string>();
  for (const source of sources) {
    if (typeof source !== 'string') continue;
    const host = hostFromSource(source);
    if (!host) continue;
    const hostname = hostnameOf(host);
    if (isIpLiteral(hostname) || isLocalName(hostname)) continue;
    hosts.add(host);
  }
  return [...hosts].sort();
}

export function isViaDomain(effectiveUrl: URL, hosts: readonly string[]): boolean {
  const normalized = normalizeHost(effectiveUrl.host);
  if (!normalized) return false;
  const hostname = hostnameOf(normalized);
  if (isIpLiteral(hostname) || isLocalName(hostname)) return false;
  const set = new Set(hosts);
  if (set.has(normalized)) return true;
  return normalized !== hostname && set.has(hostname);
}

const SERVICE_EXACT_PATHS = new Set([
  '/hub/uplink',
  '/relay/uplink',
  '/healthz',
  '/api/relay/health',
]);
/** 中继 enrollment 创建（POST 集合）、redeem（POST）与 authorization 查询（GET）：凭租户令牌，无浏览器会话。 */
const RELAY_ENROLLMENT_PATH = /^\/api\/relay\/tenants\/[^/]+\/enrollments(?:\/[^/]+)?$/;
const HUB_ENROLLMENT_PATH = /^\/api\/hub\/enrollments\/[^/]+$/;
// 密码加入的第一步：加入方尚未登录就要取租户的 KDF 参数。
const RELAY_TENANT_KDF_PATH = /^\/api\/relay\/tenants\/[^/]+\/kdf$/;

function isServiceGetPath(pathname: string): boolean {
  if (pathname === '/api/hub/status') return true;
  if (RELAY_TENANT_KDF_PATH.test(pathname)) return true;
  return HUB_ENROLLMENT_PATH.test(pathname);
}

export function isServicePath(method: string, pathname: string): boolean {
  if (SERVICE_EXACT_PATHS.has(pathname)) return true;
  if (
    pathname === '/.well-known/acme-challenge' ||
    pathname.startsWith('/.well-known/acme-challenge/')
  ) {
    return true;
  }
  const verb = method.toUpperCase();
  if (verb !== 'GET' && verb !== 'POST') return false;
  if (RELAY_ENROLLMENT_PATH.test(pathname)) return true;
  if (verb === 'GET') return isServiceGetPath(pathname);
  return (
    pathname === '/api/relay/enroll' ||
    pathname === '/api/hub/enrollments/redeem' ||
    pathname === '/api/hub/enrollments/by-password'
  );
}

export function isJsonDeniedPath(pathname: string): boolean {
  if (pathname === '/ws' || pathname === '/mesh/ws') return true;
  if (pathname.startsWith('/api/')) return true;
  const node = pathname.match(/^\/n\/[^/]+\/(.+)$/);
  if (!node?.[1]) return false;
  const rest = node[1];
  return rest === 'ws' || rest.startsWith('api/');
}

export function decideDomainAccess(input: {
  viaSelf: boolean;
  allowed: boolean;
  clientIp?: string | null;
  trustProxy?: boolean;
  headers?: Headers;
  method: string;
  pathname: string;
}): DomainAccessDecision {
  if (!input.viaSelf || input.allowed) return 'allow';
  if (isServicePath(input.method, input.pathname)) return 'allow';
  // Reverse-proxy deployments must enable TMEX_TRUST_PROXY, otherwise the proxy's
  // own socket IP is judged (typically private → allowed).
  const ip = resolveClientIp({
    socketIp: input.clientIp,
    headers: input.headers ?? new Headers(),
    trustProxy: input.trustProxy === true,
  });
  if (isLocalClientSource(ip)) return 'allow';
  return isJsonDeniedPath(input.pathname) ? 'deny-json' : 'deny-text';
}

function hostFromSource(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) return '';
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return normalizeHost(new URL(withScheme).host);
  } catch {
    return normalizeHost(trimmed);
  }
}

export function hostnameOf(normalized: string): string {
  if (normalized.startsWith('[')) {
    const end = normalized.indexOf(']');
    return end > 0 ? normalized.slice(1, end) : normalized;
  }
  if (normalized.includes(':') && normalized.indexOf(':') !== normalized.lastIndexOf(':')) {
    return normalized;
  }
  const colon = normalized.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(normalized.slice(colon + 1))) {
    return normalized.slice(0, colon);
  }
  return normalized;
}

function splitHostPort(authority: string): { hostname: string; port: string | null } | null {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) return null;
    const hostname = authority.slice(1, end);
    const rest = authority.slice(end + 1);
    if (rest === '') return { hostname, port: null };
    if (!rest.startsWith(':')) return null;
    const port = rest.slice(1);
    if (!/^\d+$/.test(port)) return null;
    return { hostname, port };
  }
  const colon = authority.lastIndexOf(':');
  const port = colon > 0 ? authority.slice(colon + 1) : '';
  if (colon > 0 && authority.indexOf(':') === colon && /^\d+$/.test(port)) {
    return { hostname: authority.slice(0, colon), port };
  }
  return { hostname: authority, port: null };
}

function stripBrackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}
