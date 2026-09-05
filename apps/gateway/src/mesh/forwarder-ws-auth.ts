import { nodeSessionCookieName, parseCookies } from '../auth/cookies';
import { MESH_REJECT_4401_KIND, type MeshUpgradeServer } from './mesh-deps';
import { jsonError } from './session-middleware';
import { readShareCookie, shareAuthValue } from './share-credential';

/**
 * `/n/<N>/ws`：带 `?share=<id>` 时只送分享凭证（常规 sid 一律不送，
 * 否则浏览器里残留的 sid 会遮蔽有效的分享凭证）；否则常规会话优先，其次分享凭证。
 */
export function remoteWsAuthFor(
  req: Request,
  nodeId: string,
  boundShareId: string | null
): string | null {
  const token = readShareCookie(req, nodeId);
  if (boundShareId) return token ? shareAuthValue(token) : null;
  const session = parseCookies(req.headers.get('cookie')).get(nodeSessionCookieName(nodeId));
  if (session) return session;
  return token ? shareAuthValue(token) : null;
}

/** 缺凭证的 `/n/<N>/ws`：分享页要拿到 SHARE_LOGIN_REQUIRED 才会退回密码表单。 */
export function rejectRemoteWs(
  req: Request,
  server: MeshUpgradeServer,
  nodeId: string,
  boundShareId: string | null
): Response | undefined {
  const code = boundShareId ? 'SHARE_LOGIN_REQUIRED' : 'NODE_LOGIN_REQUIRED';
  const upgraded = server.upgrade(req, {
    data: {
      kind: MESH_REJECT_4401_KIND,
      nodeId,
      auth: null,
      ...(boundShareId ? { closeReason: code } : {}),
    },
  });
  return upgraded ? undefined : jsonError('UNAUTHORIZED', 401, { code, nodeId });
}
