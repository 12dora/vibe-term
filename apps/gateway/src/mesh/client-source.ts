import { isLoopbackClientIp } from './address-class';
import { resolveClientIp } from './client-ip';
import { isLocalClientSource } from './domain-access-policy';
import { MESH_VIA_SELF, getMeshRequestContext } from './mesh-deps';

export const X_TMEX_CLIENT_SOURCE = 'x-tmex-client-source';
export const CLIENT_SOURCE_LOCAL = 'local';

function isLocalOrLoopbackIp(ip: string): boolean {
  return isLoopbackClientIp(ip) || isLocalClientSource(ip);
}

export function isPeerRequest(req: Request): boolean {
  const ctx = getMeshRequestContext(req);
  return ctx.via !== MESH_VIA_SELF || Boolean(ctx.clientIp?.startsWith('peer:'));
}

/**
 * 入口直达（via=self）且套接字对端本身是回环/内网时，才可能豁免通行密钥二次验证。
 * 公网套接字对端一律否，无论转发头如何；trustProxy 开启时解析出的客户端 IP 也必须是本地。
 * 见到 cf-connecting-ip 一律否；未开 trustProxy 时见到 XFF / X-Real-IP（含空值）一律否。
 */
export function isTrustedLocalClient(req: Request): boolean {
  const ctx = getMeshRequestContext(req);
  if (ctx.via !== MESH_VIA_SELF) return false;
  const socket = ctx.clientIp ?? '';
  if (!socket || socket.startsWith('peer:')) return false;
  // 套接字对端必须是本机或局域网；直连客户端的套接字就是客户端，公网对端不可伪造转发头。
  if (!isLocalOrLoopbackIp(socket)) return false;
  if (req.headers.has('cf-connecting-ip')) return false;
  const trustProxy = ctx.trustProxy === true;
  // 未开 trust-proxy 时反代会把 socket 留成本机地址；见到转发头（含空值）一律不豁免。
  if (!trustProxy && (req.headers.has('x-forwarded-for') || req.headers.has('x-real-ip'))) {
    return false;
  }
  const ip = resolveClientIp({
    socketIp: ctx.clientIp,
    headers: req.headers,
    trustProxy,
  });
  if (!ip) return false;
  return isLocalOrLoopbackIp(ip);
}

export function waivesPasskeySecondFactor(req: Request): boolean {
  if (isTrustedLocalClient(req)) return true;
  if (!isPeerRequest(req)) return false;
  return req.headers.get(X_TMEX_CLIENT_SOURCE) === CLIENT_SOURCE_LOCAL;
}
