import { type AccessTokenScope, LOGIN_RECORD_ENTRY_CLIENT_IP_HEADER } from '@vibeterm/shared';
import { authenticateTokenSecret, readTokenCredentialSecret } from '../auth/access-token-auth';
import { parseIpLiteral } from './address-class';
import { isAuthLoginPublicPath } from './auth-public-paths';

export type StreamTokenPrincipal = { tokenId: string; scopes: readonly AccessTokenScope[] };

export type StreamTokenResult =
  | { ok: true; uid: string | null; token?: StreamTokenPrincipal }
  | { ok: false; reason: string };

/** 入口随 OPEN 带来的真实客户端 IP；缺失或非法时退回对端节点标识，供令牌使用记录。 */
export function tokenClientIp(entryIp: unknown, peerNodeId: string): string {
  const parsed = typeof entryIp === 'string' ? parseIpLiteral(entryIp) : undefined;
  return parsed ?? `peer:${peerNodeId}`;
}

function entryIpOf(headers: Record<string, string>): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === LOGIN_RECORD_ENTRY_CLIENT_IP_HEADER) return value;
  }
  return undefined;
}

/**
 * HTTP 流上的 `tok:<secret>` 凭证。登录前公开面把令牌当作没带（匿名放行）；其余路径令牌无效
 * 一律回同一个原因，不区分未知 / 过期 / 已撤销。
 */
export function authorizeTokenHttpStream(
  credential: string,
  method: string,
  pathname: string,
  peerNodeId: string,
  headers: Record<string, string>
): StreamTokenResult {
  if (isAuthLoginPublicPath(pathname, method) || pathname.startsWith('/api/mesh-internal/')) {
    return { ok: true, uid: null };
  }
  const ip = tokenClientIp(entryIpOf(headers), peerNodeId);
  const principal = authenticateTokenSecret(readTokenCredentialSecret(credential), ip);
  if (!principal) return { ok: false, reason: 'token_invalid' };
  return {
    ok: true,
    uid: principal.userId,
    token: { tokenId: principal.tokenId, scopes: principal.scopes },
  };
}
