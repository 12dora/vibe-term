import type { LoginPolicy } from '@vibeterm/shared/auth';
import {
  clientIpFromRequest,
  limiterIpKey,
  requestHasProxyHeaders,
  resolveClientIp,
} from './client-ip';
import { isPeerRequest, isTrustedLocalClient } from './client-source';
import { getMeshRequestContext } from './mesh-deps';

/**
 * 登录 IP 阶梯的桶键。未开 trust-proxy 时，本机 / 内网反代转发来的请求不能全挤在代理的套接字上：
 * 用 `proxied:` 加配置头里声称的地址分开桶（可伪造，只做隔离）；公网套接字一律按套接字计。
 * peer 入站不按 IP 计。
 */
export function loginLimiterIp(req: Request): string {
  if (isPeerRequest(req)) return '';
  const ctx = getMeshRequestContext(req);
  if (ctx.trustProxy !== true && requestHasProxyHeaders(req.headers)) {
    const claimed = resolveClientIp({
      socketIp: ctx.clientIp,
      headers: req.headers,
      trustProxy: true,
      clientIpHeader: ctx.clientIpHeader,
    });
    if (claimed !== ctx.clientIp?.trim()) return `proxied:${limiterIpKey(claimed)}`;
  }
  return limiterIpKey(clientIpFromRequest(req));
}

/** 与通行密钥豁免同一判定（`isTrustedLocalClient`）；`exemptLocal` 开启时同时跳过 IP 阶梯和账号暂停。 */
export function loginIpExempt(policy: Pick<LoginPolicy, 'exemptLocal'>, req: Request): boolean {
  return policy.exemptLocal && isTrustedLocalClient(req);
}
