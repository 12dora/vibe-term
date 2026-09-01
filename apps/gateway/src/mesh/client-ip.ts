import { isLoopbackClientIp } from '../db/local-auth-settings';
import { getMeshRequestContext } from './mesh-deps';

export type ClientIpInput = {
  socketIp?: string | null;
  headers: Headers;
  trustProxy: boolean;
};

const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function resolveClientIp(input: ClientIpInput): string | undefined {
  const socket = trimOrUndef(input.socketIp);
  if (!input.trustProxy) return socket;
  return pickForwardedClientIp(input.headers) ?? socket;
}

export function isRequestLoopback(input: ClientIpInput): boolean {
  // Cloudflare 才会设置 CF-Connecting-IP；直连 localhost 不会带。只要出现即视为远端，
  // 与是否信任代理无关——否则代理保留的 `127.0.0.1` / 非法值会在信任模式下重新打开本机 bootstrap。
  if (headerValue(input.headers, 'cf-connecting-ip')) return false;
  return isLoopbackClientIp(resolveClientIp(input));
}

export function clientIpFromRequest(req: Request): string | undefined {
  return resolveClientIp(inputFromRequest(req));
}

export function requestIsLoopback(req: Request): boolean {
  return isRequestLoopback(inputFromRequest(req));
}

function inputFromRequest(req: Request): ClientIpInput {
  const ctx = getMeshRequestContext(req);
  return {
    socketIp: ctx.clientIp,
    headers: req.headers,
    trustProxy: ctx.trustProxy === true,
  };
}

function pickForwardedClientIp(headers: Headers): string | undefined {
  const candidates = [
    headerValue(headers, 'cf-connecting-ip'),
    firstForwardedFor(headers.get('x-forwarded-for')),
    headerValue(headers, 'x-real-ip'),
  ];
  for (const raw of candidates) {
    const ip = parseIpLiteral(raw);
    if (ip) return ip;
  }
  return undefined;
}

function firstForwardedFor(value: string | null): string | undefined {
  if (!value) return undefined;
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function headerValue(headers: Headers, name: string): string | undefined {
  return trimOrUndef(headers.get(name));
}

function trimOrUndef(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseIpLiteral(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let host = raw.trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zone = host.indexOf('%');
  if (zone >= 0) host = host.slice(0, zone);
  if (!host) return undefined;
  if (IPV4_RE.test(host)) return host;
  const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped?.[1] && IPV4_RE.test(mapped[1])) return host.toLowerCase();
  if (isIpv6(host)) return host.toLowerCase();
  return undefined;
}

function isIpv6(host: string): boolean {
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
