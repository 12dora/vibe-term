import {
  type TokenPrincipal,
  authenticateTokenSecret,
  readLocalTokenSecret,
} from '../auth/access-token-auth';
import { tokenScopeAllows } from '../auth/token-scope';
import { isAuthLoginPublicPath } from './auth-public-paths';
import { clientIpFromRequest } from './client-ip';
import { MESH_VIA_SELF, getMeshRequestContext, setMeshRequestContext } from './mesh-deps';
import { type SessionMiddlewareDeps, authenticateRequest, jsonError } from './session-middleware';

/**
 * 令牌作用域的唯一执行点：本机请求（localUiGuard、`/n/self/...` 改写后的请求）和 mesh 入站
 * （目标节点收到的 `tok:` 流）都在进入 AuthRoutes / 网关路由之前过这里。
 * 上下文里没有 tokenId 的请求（会话调用方、公开面）原样放行。
 */
export function tokenScopeDenied(req: Request): Response | null {
  const ctx = getMeshRequestContext(req);
  if (!ctx.tokenId) return null;
  const url = new URL(req.url);
  if (isAuthLoginPublicPath(url.pathname, req.method)) return null;
  if (tokenScopeAllows(req.method, url.pathname, ctx.tokenScopes ?? [])) return null;
  return jsonError('TOKEN_SCOPE', 403, { message: 'token scope does not allow this request' });
}

/** 本机请求里的令牌 principal；只在会话鉴权失败后才会被问到。 */
export function localTokenPrincipal(req: Request): TokenPrincipal | null {
  if (getMeshRequestContext(req).via !== MESH_VIA_SELF) return null;
  const secret = readLocalTokenSecret(req);
  if (!secret) return null;
  return authenticateTokenSecret(secret, clientIpFromRequest(req));
}

function attachTokenPrincipal(req: Request, principal: TokenPrincipal): void {
  setMeshRequestContext(req, {
    ...getMeshRequestContext(req),
    sid: null,
    auth: null,
    uid: principal.userId,
    tokenId: principal.tokenId,
    tokenScopes: principal.scopes,
  });
}

/**
 * 本机 `/api/*` 的鉴权：有效会话永远优先（令牌根本不看）；没有有效会话才试令牌。
 * 令牌无效与没带凭证同样回 401；令牌有效但作用域不含该请求回 403 TOKEN_SCOPE。
 */
export function authenticateApiRequest(req: Request, deps: SessionMiddlewareDeps): Response | null {
  if (authenticateRequest(req, deps).ok) return null;
  const principal = localTokenPrincipal(req);
  if (!principal) return jsonError('UNAUTHORIZED', 401);
  attachTokenPrincipal(req, principal);
  return tokenScopeDenied(req);
}
