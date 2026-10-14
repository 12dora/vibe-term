import type { AccessTokenScope } from '@vibeterm/shared';
import { verifyAccessToken } from './access-tokens';
import { parseCookies } from './cookies';

export const TOKEN_CREDENTIAL_PREFIX = 'tok:';
export const ACCESS_TOKEN_COOKIE_PREFIX = 'vibeterm_t_';
const BEARER = /^Bearer\s+(\S+)\s*$/i;

export type TokenPrincipal = {
  tokenId: string;
  userId: string;
  scopes: readonly AccessTokenScope[];
};

export function accessTokenCookieName(nodeId: string): string {
  return `${ACCESS_TOKEN_COOKIE_PREFIX}${nodeId}`;
}

export function isTokenCredential(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(TOKEN_CREDENTIAL_PREFIX);
}

export function tokenCredentialValue(secret: string): string {
  return `${TOKEN_CREDENTIAL_PREFIX}${secret}`;
}

export function readTokenCredentialSecret(value: string): string {
  return value.slice(TOKEN_CREDENTIAL_PREFIX.length);
}

export function readAccessTokenCookie(cookies: Map<string, string>, nodeId: string): string | null {
  return cookies.get(accessTokenCookieName(nodeId)) || null;
}

/** 本机请求携带的令牌：`Authorization: Bearer` 优先，其次 `vibeterm_t_self` cookie。 */
export function readLocalTokenSecret(req: Request): string | null {
  const bearer = BEARER.exec(req.headers.get('authorization') ?? '')?.[1];
  if (bearer) return bearer;
  return readAccessTokenCookie(parseCookies(req.headers.get('cookie')), 'self');
}

/**
 * 令牌校验的唯一入口：失败原因只进 debug 日志（不含密文），调用方一律当作同一种未认证。
 */
export function authenticateTokenSecret(
  secret: string,
  ip: string | null | undefined
): TokenPrincipal | null {
  let result: ReturnType<typeof verifyAccessToken>;
  try {
    result = verifyAccessToken(secret, { ip });
  } catch (err) {
    console.debug(`[access-token] verify error ${err instanceof Error ? err.name : 'unknown'}`);
    return null;
  }
  if (!result.ok) {
    console.debug(`[access-token] verify failed reason=${result.reason}`);
    return null;
  }
  return { tokenId: result.tokenId, userId: result.userId, scopes: result.scopes };
}
