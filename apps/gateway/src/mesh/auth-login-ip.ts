import type { LoginPolicy } from '@vibeterm/shared/auth';
import { isLoopbackClientIp } from './address-class';
import { clientIpFromRequest, requestHasProxyHeaders } from './client-ip';
import { isPeerRequest } from './client-source';
import { isLocalClientSource } from './domain-access-policy';
import { getMeshRequestContext } from './mesh-deps';

const CLAIM_MAX = 128;

/**
 * 登录 IP 阶梯的桶键。未开 trust-proxy 时转发头不可信，但也不能让所有客户端
 * 挤在回环套接字上：用 `proxied:` 加对方声称的地址分开桶（可伪造，只做隔离）。
 * peer 入站不按 IP 计。
 */
export function loginLimiterIp(req: Request): string {
  if (isPeerRequest(req)) return '';
  const ctx = getMeshRequestContext(req);
  if (ctx.trustProxy !== true && requestHasProxyHeaders(req.headers)) {
    return `proxied:${claimedProxyClient(req.headers)}`;
  }
  return clientIpFromRequest(req) ?? 'local';
}

/** 无代理头，且套接字是回环或局域网。`exemptLocal` 开启时，这类请求同时跳过 IP 阶梯和账号暂停。 */
export function loginIpExempt(policy: Pick<LoginPolicy, 'exemptLocal'>, req: Request): boolean {
  if (!policy.exemptLocal || isPeerRequest(req) || requestHasProxyHeaders(req.headers))
    return false;
  const socket = getMeshRequestContext(req).clientIp ?? '';
  if (!socket || socket.startsWith('peer:')) return false;
  return isLoopbackClientIp(socket) || isLocalClientSource(socket);
}

export function claimedProxyClient(headers: Headers): string {
  const raw =
    headerToken(headers, 'cf-connecting-ip') ??
    headerToken(headers, 'x-real-ip') ??
    lastCommaToken(headers.get('x-forwarded-for')) ??
    lastForwardedFor(headers.get('forwarded')) ??
    'unknown';
  return clipClaim(raw);
}

function headerToken(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)?.trim();
  return value || undefined;
}

function lastCommaToken(value: string | null): string | undefined {
  if (!value) return undefined;
  const parts = value.split(',');
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const trimmed = parts[i]?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function lastForwardedFor(value: string | null): string | undefined {
  if (!value) return undefined;
  let found: string | undefined;
  for (const part of value.split(',')) {
    const match = /for=\s*"?\[?([^";,\]]+)/i.exec(part);
    const token = match?.[1]?.trim();
    if (token) found = token;
  }
  return found;
}

function clipClaim(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'unknown';
  return trimmed.length > CLAIM_MAX ? trimmed.slice(0, CLAIM_MAX) : trimmed;
}
