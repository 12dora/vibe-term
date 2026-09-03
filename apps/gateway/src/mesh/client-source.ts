import { isLoopbackClientIp } from '../db/local-auth-settings';
import { resolveClientIp } from './client-ip';
import { isLocalClientSource } from './domain-access-policy';
import { MESH_VIA_SELF, getMeshRequestContext } from './mesh-deps';

export const X_TMEX_CLIENT_SOURCE = 'x-tmex-client-source';
export const CLIENT_SOURCE_LOCAL = 'local';

function headerPresent(headers: Headers, name: string): boolean {
  const value = headers.get(name)?.trim();
  return Boolean(value);
}

export function isPeerRequest(req: Request): boolean {
  const ctx = getMeshRequestContext(req);
  return ctx.via !== MESH_VIA_SELF || Boolean(ctx.clientIp?.startsWith('peer:'));
}

export function isTrustedLocalClient(req: Request): boolean {
  const ctx = getMeshRequestContext(req);
  if (ctx.via !== MESH_VIA_SELF) return false;
  if ((ctx.clientIp ?? '').startsWith('peer:')) return false;
  if (headerPresent(req.headers, 'cf-connecting-ip')) return false;
  const trustProxy = ctx.trustProxy === true;
  // 未开 trust-proxy 时反代会把 socket 留成本机地址；见到转发头一律不豁免。
  if (
    !trustProxy &&
    (headerPresent(req.headers, 'x-forwarded-for') || headerPresent(req.headers, 'x-real-ip'))
  ) {
    return false;
  }
  const ip = resolveClientIp({
    socketIp: ctx.clientIp,
    headers: req.headers,
    trustProxy,
  });
  if (!ip) return false;
  return isLoopbackClientIp(ip) || isLocalClientSource(ip);
}

export function waivesPasskeySecondFactor(req: Request): boolean {
  if (isTrustedLocalClient(req)) return true;
  if (!isPeerRequest(req)) return false;
  return req.headers.get(X_TMEX_CLIENT_SOURCE) === CLIENT_SOURCE_LOCAL;
}
