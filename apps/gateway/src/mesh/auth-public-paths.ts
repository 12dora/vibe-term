/** 与 node 相同的登录前公开面；role 无关。 */
export const AUTH_LOGIN_PUBLIC_PATHS = new Set([
  '/api/auth/mode',
  '/api/auth/nodes',
  '/api/auth/challenge',
  '/api/auth/login',
  '/api/auth/passkey/login/options',
]);
