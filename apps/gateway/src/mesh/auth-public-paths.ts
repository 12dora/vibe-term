/** 与 node 相同的登录前公开面；role 无关。 */
export const AUTH_LOGIN_PUBLIC_PATHS = new Set([
  '/api/auth/mode',
  '/api/auth/nodes',
  '/api/auth/challenge',
  '/api/auth/login',
  '/api/auth/passkey/login/options',
]);

/** 被分享人的公开面：无常规会话，只认 `tmex_sh_<via>` cookie。 */
export const SHARE_ACCESS_PATH_PREFIX = '/api/share-access/';

export function isShareAccessPath(path: string): boolean {
  return path === '/api/share-access' || path.startsWith(SHARE_ACCESS_PATH_PREFIX);
}

/** 登录前公开面 + 分享公开面：localUiGuard、forwarder 与节点侧流入口共用同一判定。 */
export function isAuthLoginPublicPath(path: string): boolean {
  return AUTH_LOGIN_PUBLIC_PATHS.has(path) || isShareAccessPath(path);
}
