const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const DEFAULT_PORTS = new Set(['80', '443']);

export type DomainAccessDecision = 'allow' | 'deny-json' | 'deny-text';

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
  if (IPV4_RE.test(hostname)) return true;
  const mapped = hostname.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped?.[1] && IPV4_RE.test(mapped[1])) return true;
  return looksLikeIpv6(hostname);
}

export function isLocalName(host: string): boolean {
  const hostname = stripBrackets(hostnameOf(normalizeHost(host) || host.toLowerCase()));
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === 'local' || hostname.endsWith('.local')) return true;
  return isLoopbackHostname(hostname);
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

export function isServicePath(method: string, pathname: string): boolean {
  if (pathname === '/hub/uplink') return true;
  if (pathname === '/healthz') return true;
  if (
    pathname === '/.well-known/acme-challenge' ||
    pathname.startsWith('/.well-known/acme-challenge/')
  ) {
    return true;
  }
  const verb = method.toUpperCase();
  if (verb === 'POST' && pathname === '/api/hub/enrollments/redeem') return true;
  if (verb === 'GET' && pathname === '/api/hub/status') return true;
  if (verb === 'GET' && /^\/api\/hub\/enrollments\/[^/]+$/.test(pathname)) return true;
  return false;
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
  hosts: readonly string[];
  effectiveUrl: URL;
  method: string;
  pathname: string;
}): DomainAccessDecision {
  if (!input.viaSelf || input.allowed) return 'allow';
  if (!isViaDomain(input.effectiveUrl, input.hosts)) return 'allow';
  if (isServicePath(input.method, input.pathname)) return 'allow';
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

function looksLikeIpv6(host: string): boolean {
  if (/^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/i.test(host)) return true;
  if (!/^[0-9a-fA-F:]+$/.test(host)) return false;
  const sides = host.split('::');
  if (sides.length > 2) return false;
  const parseSide = (side: string): string[] | null => {
    if (side === '') return [];
    const groups = side.split(':');
    if (groups.some((g) => !g || g.length > 4 || !/^[0-9a-fA-F]+$/.test(g))) return null;
    return groups;
  };
  if (sides.length === 2) {
    const left = parseSide(sides[0] ?? '');
    const right = parseSide(sides[1] ?? '');
    if (!left || !right) return false;
    return left.length + right.length <= 7;
  }
  const groups = parseSide(host);
  return groups != null && groups.length === 8;
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === '::1') return true;
  const mapped = hostname.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  const ipv4 = mapped?.[1] ?? (IPV4_RE.test(hostname) ? hostname : null);
  if (!ipv4) return false;
  const first = Number(ipv4.split('.')[0]);
  return first === 127;
}
