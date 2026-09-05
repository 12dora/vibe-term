import { buildClearCookie, buildSetCookie, parseCookies } from '../auth/cookies';
import { getShareService } from '../share';
import {
  SHARE_AUTH_PREFIX,
  X_TMEX_CLEAR_SHARE,
  X_TMEX_SET_SHARE,
  X_TMEX_SET_SHARE_MAX_AGE,
  isValidShareCookieVia,
  shareCookieName,
} from '../share/share-token';
import type { VerifiedShareAccess } from '../share/types';

export {
  SHARE_AUTH_PREFIX,
  X_TMEX_CLEAR_SHARE,
  X_TMEX_SET_SHARE,
  X_TMEX_SET_SHARE_MAX_AGE,
  shareCookieName,
};

export type ShareAccessVerification = VerifiedShareAccess;

export type ShareAccessVerifier = (
  token: string,
  now?: number
) => ShareAccessVerification | null | undefined;

let override: ShareAccessVerifier | null = null;

/** 单测注入用；生产走 share 服务。 */
export function setShareAccessVerifier(fn: ShareAccessVerifier | null): void {
  override = fn;
}

export function verifyShareAccessToken(
  token: string | null | undefined,
  now?: number
): ShareAccessVerification | null {
  if (!token) return null;
  try {
    if (override) return override(token, now) ?? null;
    return getShareService().verifyAccessToken(token, now) ?? null;
  } catch {
    return null;
  }
}

export function readShareCookie(req: Request, via: string): string | null {
  if (!isValidShareCookieVia(via)) return null;
  return parseCookies(req.headers.get('cookie')).get(shareCookieName(via)) ?? null;
}

export function shareAuthValue(token: string): string {
  return `${SHARE_AUTH_PREFIX}${token}`;
}

/** 取出 `share:<token>` 里的 token；不是分享凭证时返回 null。 */
export function parseShareAuth(auth: string | null | undefined): string | null {
  if (typeof auth !== 'string' || !auth.startsWith(SHARE_AUTH_PREFIX)) return null;
  const token = auth.slice(SHARE_AUTH_PREFIX.length);
  return token || null;
}

export function hasShareCookieHeaders(response: Response): boolean {
  return response.headers.has(X_TMEX_SET_SHARE) || response.headers.has(X_TMEX_CLEAR_SHARE);
}

/**
 * 把节点端的 `x-tmex-set-share` / `x-tmex-clear-share` 翻成浏览器 cookie，并抹掉内部头。
 * 本机路径 via = `self`，Hub 路径 via = 目标节点 id。
 */
export function applyShareCookieHeaders(
  headers: Headers,
  upstream: Response,
  via: string,
  secure: boolean
): void {
  headers.delete(X_TMEX_SET_SHARE);
  headers.delete(X_TMEX_SET_SHARE_MAX_AGE);
  headers.delete(X_TMEX_CLEAR_SHARE);
  if (!isValidShareCookieVia(via)) return;
  const name = shareCookieName(via);
  const token = upstream.headers.get(X_TMEX_SET_SHARE)?.trim();
  const maxAgeRaw = Number(upstream.headers.get(X_TMEX_SET_SHARE_MAX_AGE) ?? '');
  if (token && Number.isFinite(maxAgeRaw)) {
    headers.append(
      'set-cookie',
      buildSetCookie(name, token, { maxAgeSec: Math.max(0, Math.floor(maxAgeRaw)), secure })
    );
  }
  if (upstream.headers.get(X_TMEX_CLEAR_SHARE)) {
    headers.append('set-cookie', buildClearCookie(name, { secure }));
  }
}
