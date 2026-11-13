import {
  isIpv4DottedLiteral,
  isLoopbackClientIp,
  parseIpLiteral,
  parseIpv6Words,
} from './address-class';
import { type ClientIpHeader, DEFAULT_CLIENT_IP_HEADER } from './client-ip-header';
import { isLocalClientSource } from './domain-access-policy';
import { MESH_VIA_SELF, getMeshRequestContext } from './mesh-deps';
import { authorityAllowed, requestAuthority } from './request-authority';

const IPV4_MAPPED_DOTTED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
] as const;

/** 不携带客户端地址、但同样说明请求经过了代理的头；只用于「是否经代理」判定，不参与地址解析。 */
const PROXY_EVIDENCE_HEADERS = [
  ...FORWARDING_HEADERS,
  'x-forwarded-proto',
  'x-forwarded-host',
  'via',
  'true-client-ip',
  'x-client-ip',
] as const;

const MISSING_HEADER_WARN_MAX = 32;
const missingHeaderWarned = new Set<string>();

export const UNKNOWN_CLIENT_KEY = 'unknown';

/** 只要出现任何一个转发头（含空值），请求就经过了代理，套接字对端不是客户端本人。 */
export function requestHasProxyHeaders(headers: Headers): boolean {
  for (const name of FORWARDING_HEADERS) {
    if (headers.has(name)) return true;
  }
  return false;
}

export function requestShowsProxyEvidence(headers: Headers): boolean {
  return PROXY_EVIDENCE_HEADERS.some((name) => headers.has(name));
}

/** 每个进程对每种「有转发头、缺配置头」的组合只告警一次。 */
function warnMissingClientIpHeader(name: ClientIpHeader, headers: Headers): void {
  const present = FORWARDING_HEADERS.filter((h) => headers.has(h)).join(',');
  const key = `${name}|${present}`;
  if (missingHeaderWarned.has(key) || missingHeaderWarned.size >= MISSING_HEADER_WARN_MAX) return;
  missingHeaderWarned.add(key);
  console.warn(
    `[client-ip] proxied request lacks VIBETERM_CLIENT_IP_HEADER=${name} (present: ${present}); all such clients share the "unknown" rate-limit bucket. Set the header your proxy sends.`
  );
}

export type ClientIpInput = {
  socketIp?: string | null;
  headers: Headers;
  trustProxy: boolean;
  clientIpHeader?: ClientIpHeader;
};

function isLocalAddress(ip: string): boolean {
  return isLoopbackClientIp(ip) || isLocalClientSource(ip);
}

/** 本请求是否来自受信反代那一跳：trustProxy 开启、via=self、套接字对端是回环/内网。 */
export function isTrustedProxyHop(req: Request): boolean {
  const ctx = getMeshRequestContext(req);
  if (ctx.trustProxy !== true || ctx.via !== MESH_VIA_SELF) return false;
  const socket = ctx.clientIp ?? '';
  return Boolean(socket) && !socket.startsWith('peer:') && isLocalAddress(socket);
}

/**
 * 唯一的「客户端是谁」解析：只有 trustProxy 开启、且套接字对端是回环/内网（代理那一跳）时，
 * 才读配置的那一个转发头；`x-forwarded-for` 取最右一项（受信代理追加的那一项）。
 * 已经过代理但取不到合法地址时返回 undefined，不退回代理自己的套接字地址。
 */
export function resolveClientIp(input: ClientIpInput): string | undefined {
  const socket = trimOrUndef(input.socketIp);
  if (!input.trustProxy || !socket || !isLocalAddress(socket)) return socket;
  const name = input.clientIpHeader ?? DEFAULT_CLIENT_IP_HEADER;
  const raw = input.headers.get(name);
  if (raw === null) {
    if (!requestHasProxyHeaders(input.headers)) return socket;
    warnMissingClientIpHeader(name, input.headers);
    return undefined;
  }
  const value = name === 'x-forwarded-for' ? raw.slice(raw.lastIndexOf(',') + 1) : raw;
  return parseIpLiteral(value.trim());
}

export function clientIpFromRequest(req: Request): string | undefined {
  const ctx = getMeshRequestContext(req);
  return resolveClientIp({
    socketIp: ctx.clientIp,
    headers: req.headers,
    trustProxy: ctx.trustProxy === true,
    clientIpHeader: ctx.clientIpHeader,
  });
}

export type LocalClientClass = 'loopback' | 'lan';

/**
 * 只看套接字的本机判定：入口直达（via=self）、套接字对端不是 `peer:`、且请求没有任何经代理的迹象时，
 * 按套接字对端分回环 / 内网；其余一律 null。与 trustProxy 无关，永远不看转发头里的地址。
 */
export function directLocalClass(req: Request): LocalClientClass | null {
  const ctx = getMeshRequestContext(req);
  if (ctx.via !== MESH_VIA_SELF) return null;
  const socket = trimOrUndef(ctx.clientIp);
  if (!socket || socket.startsWith('peer:')) return null;
  if (requestShowsProxyEvidence(req.headers)) return null;
  if (isLoopbackClientIp(socket)) return 'loopback';
  return isLocalClientSource(socket) ? 'lan' : null;
}

/**
 * 特权本机判定的唯一实现：`directLocalClass`，且请求 `Host` 是本机认得的名字
 * （IP 字面量、localhost、本机 mDNS 名或已配置域名，见 request-authority.ts）。
 */
export function localClientClass(req: Request): LocalClientClass | null {
  const direct = directLocalClass(req);
  if (direct === null) return null;
  return authorityAllowed(requestAuthority(req)) ? direct : null;
}

/** 可作为「来源可信」依据的客户端地址：直连本机 / 内网套接字，或受信反代那一跳解析出的地址。 */
export function trustedSourceIp(req: Request): string | null {
  if (directLocalClass(req) !== null)
    return trimOrUndef(getMeshRequestContext(req).clientIp) ?? null;
  return isTrustedProxyHop(req) ? (clientIpFromRequest(req) ?? null) : null;
}

/**
 * 能代表单个客户端的限流键；经代理却未受信（键其实是代理地址）或取不到地址时返回 null，
 * 调用方只按全局上限计数。
 */
export function clientLimiterKey(req: Request): string | null {
  const ip = clientIpFromRequest(req);
  if (!ip) return null;
  const proxiedUntrusted =
    getMeshRequestContext(req).trustProxy !== true && requestShowsProxyEvidence(req.headers);
  if (proxiedUntrusted && isLocalAddress(ip)) return null;
  return limiterIpKey(ip);
}

export function requestIsLoopback(req: Request): boolean {
  return localClientClass(req) === 'loopback';
}

/**
 * 限流桶键：IPv6 按 /64 归桶（同一前缀下轮换源地址不换桶），v4-mapped 还原成点分 IPv4，
 * 缺失为 `unknown`；`peer:` 等非地址值原样返回。
 */
export function limiterIpKey(ip: string | null | undefined): string {
  const value = trimOrUndef(ip);
  if (!value) return UNKNOWN_CLIENT_KEY;
  const parsed = parseIpLiteral(value);
  if (!parsed) return value;
  if (isIpv4DottedLiteral(parsed)) return parsed;
  const mapped = parsed.match(IPV4_MAPPED_DOTTED);
  if (mapped?.[1]) return mapped[1];
  const words = parseIpv6Words(parsed);
  if (!words) return parsed;
  const prefix = words.slice(0, 4).map((w) => w.toString(16));
  return `${prefix.join(':')}::/64`;
}

/** 从 clientIp 抽出 dotted IPv4（含 v4-mapped）；IPv6 / 非法值返回 undefined。 */
export function observedIpv4FromClientIp(raw: string | undefined): string | undefined {
  const parsed = parseIpLiteral(raw);
  if (!parsed) return undefined;
  if (isIpv4DottedLiteral(parsed)) return parsed;
  const mapped = parsed.match(IPV4_MAPPED_DOTTED);
  return mapped?.[1] && isIpv4DottedLiteral(mapped[1]) ? mapped[1] : undefined;
}

function trimOrUndef(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
