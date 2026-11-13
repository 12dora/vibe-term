import { localClientClass } from './client-ip';
import { MESH_VIA_SELF, getMeshRequestContext } from './mesh-deps';

export function isPeerRequest(req: Request): boolean {
  const ctx = getMeshRequestContext(req);
  return ctx.via !== MESH_VIA_SELF || Boolean(ctx.clientIp?.startsWith('peer:'));
}

/** 套接字对端本身是回环 / 内网、入口直达、且不带任何转发头。转发头里的地址永远不参与。 */
export function isTrustedLocalClient(req: Request): boolean {
  return localClientClass(req) !== null;
}

/**
 * 每个节点只按自己的套接字判定；peer 链路上入口声称的「本机来源」一律不认，
 * 否则任一成员节点都能替目标关掉通行密钥二次验证。
 */
export function waivesPasskeySecondFactor(req: Request): boolean {
  return isTrustedLocalClient(req);
}
