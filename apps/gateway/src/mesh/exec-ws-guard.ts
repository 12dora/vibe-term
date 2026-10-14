import { type ExecUpgradeAuth, handleExecWsUpgrade } from '../exec/channel/ws-upgrade';
import { MESH_VIA_SELF, type MeshUpgradeServer } from './mesh-deps';
import { type SessionMiddlewareDeps, authenticateRequest, jsonError } from './session-middleware';
import { localTokenPrincipal } from './token-guard';

/**
 * exec 通道升级的唯一鉴权扩展点。会话优先（standalone 开放短路为无主身份）；没有有效会话才认
 * 访问令牌，且令牌必须带 `exec` 作用域。分享凭证不能开 shell。
 */
export function authenticateExecUpgrade(
  req: Request,
  deps: SessionMiddlewareDeps
): ExecUpgradeAuth | Response {
  const auth = authenticateRequest(req, deps);
  if (auth.ok) {
    const session = auth.sid ? { sid: auth.sid, viaNodeId: MESH_VIA_SELF } : null;
    return { uid: auth.userId, tokenId: null, session };
  }
  const principal = localTokenPrincipal(req);
  if (!principal) return jsonError('UNAUTHORIZED', 401);
  if (!principal.scopes.includes('exec')) return jsonError('TOKEN_SCOPE', 403);
  return { uid: principal.userId, tokenId: principal.tokenId };
}

export function guardExecWebSocket(
  req: Request,
  server: MeshUpgradeServer,
  deps: SessionMiddlewareDeps
): Response | undefined {
  return handleExecWsUpgrade(req, server, (request) => authenticateExecUpgrade(request, deps));
}
