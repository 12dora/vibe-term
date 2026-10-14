import { type ExecUpgradeAuth, handleExecWsUpgrade } from '../exec/channel/ws-upgrade';
import type { MeshUpgradeServer } from './mesh-deps';
import { type SessionMiddlewareDeps, authenticateRequest, jsonError } from './session-middleware';

/**
 * exec 通道升级的唯一鉴权扩展点：新增凭证类型（如 access token）只改这里。
 * 目前只认常规会话（standalone 开放短路为无主身份），分享凭证不能开 shell。
 */
export function authenticateExecUpgrade(
  req: Request,
  deps: SessionMiddlewareDeps
): ExecUpgradeAuth | Response {
  const auth = authenticateRequest(req, deps);
  if (!auth.ok) return jsonError('UNAUTHORIZED', 401);
  return { uid: auth.userId, tokenId: null };
}

export function guardExecWebSocket(
  req: Request,
  server: MeshUpgradeServer,
  deps: SessionMiddlewareDeps
): Response | undefined {
  return handleExecWsUpgrade(req, server, (request) => authenticateExecUpgrade(request, deps));
}
