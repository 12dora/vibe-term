import { readAccessTokenCookie, tokenCredentialValue } from '../auth/access-token-auth';
import { parseCookies, readNodeSessionCookie } from '../auth/cookies';
import { isShareAccessPath } from './auth-public-paths';
import { AUTH_SKIP } from './forwarder-auth-policy';
import { readShareCookie, shareAuthValue } from './share-credential';

/**
 * 入口发往目标节点的会话凭证：该节点的会话 cookie；没有会话时才退到该节点的令牌 cookie
 * （`tok:<secret>`）。有会话永远优先，令牌不会遮蔽也不会补充会话。
 */
export function sessionOrTokenCredential(req: Request, nodeId: string): string | null {
  const cookies = parseCookies(req.headers.get('cookie'));
  const session = readNodeSessionCookie(cookies, nodeId);
  if (session) return session;
  const token = readAccessTokenCookie(cookies, nodeId);
  return token ? tokenCredentialValue(token) : null;
}

/**
 * 转发到目标节点的凭证：分享公开面用 `share:<token>`（`vibeterm_sh_<nodeId>` cookie），
 * 登录前公开面不带凭证，其余用会话 cookie，缺会话时用令牌 cookie。
 */
export function forwardedAuthFor(req: Request, nodeId: string, rest: string): string | null {
  if (isShareAccessPath(rest, req.method)) {
    const token = readShareCookie(req, nodeId);
    return token ? shareAuthValue(token) : null;
  }
  if (AUTH_SKIP.has(rest)) return null;
  return sessionOrTokenCredential(req, nodeId);
}
