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

/** 契约 §2.3 的三个端点，逐条列出：同前缀新增管理路由不会被顺带匿名开放。 */
const SHARE_ACCESS_ENDPOINTS: ReadonlyArray<{ tail: string | null; method: string }> = [
  { tail: null, method: 'GET' },
  { tail: 'login', method: 'POST' },
  { tail: 'logout', method: 'POST' },
];

/**
 * `/api/share-access/:id`（GET）、`/api/share-access/:id/login`、`/api/share-access/:id/logout`（POST）。
 * 拿得到方法就一并校验；只有路径的调用点（localUiGuard、流入口白名单）按形状判定。
 */
export function isShareAccessPath(path: string, method?: string): boolean {
  if (!path.startsWith(SHARE_ACCESS_PATH_PREFIX)) return false;
  const segments = path.slice(SHARE_ACCESS_PATH_PREFIX.length).split('/');
  const id = segments[0];
  if (!id || segments.length > 2) return false;
  const tail = segments.length === 2 ? segments[1] : null;
  if (tail === '') return false;
  const endpoint = SHARE_ACCESS_ENDPOINTS.find((row) => row.tail === tail);
  if (!endpoint) return false;
  return method === undefined || method.toUpperCase() === endpoint.method;
}

/** 登录前公开面 + 分享公开面：localUiGuard、forwarder 与节点侧流入口共用同一判定。 */
export function isAuthLoginPublicPath(path: string, method?: string): boolean {
  return AUTH_LOGIN_PUBLIC_PATHS.has(path) || isShareAccessPath(path, method);
}
