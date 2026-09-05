import { SHARE_WS_CLOSE_ENDED } from '@tmex/shared/share';
import { buildClearCookie, buildSetCookie, parseCookies } from '../auth/cookies';
import { getShareService } from '../share';
import {
  SHARE_AUTH_PREFIX,
  SHARE_COOKIE_PREFIX,
  X_TMEX_CLEAR_SHARE,
  X_TMEX_SET_SHARE,
  X_TMEX_SET_SHARE_MAX_AGE,
  isValidShareCookieVia,
  parseShareToken,
  shareCookieName,
} from '../share/share-token';
import type { VerifiedShareAccess } from '../share/types';
import { isShareAccessPath } from './auth-public-paths';
import { WS_CLOSE_LOGIN_REQUIRED } from './mesh-deps';

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

/** 分享是否已结束：用于把「凭证不认」细分成 4401（重新登录）与 4410（分享没了）。 */
export type ShareEndedReader = (shareId: string) => boolean;

let endedOverride: ShareEndedReader | null = null;

/** 单测注入用；生产读 share 服务的记录状态。 */
export function setShareEndedReader(fn: ShareEndedReader | null): void {
  endedOverride = fn;
}

export function isShareEnded(shareId: string | null | undefined): boolean {
  if (!shareId) return false;
  try {
    if (endedOverride) return endedOverride(shareId);
    return getShareService().get(shareId)?.state === 'ended';
  } catch {
    return false;
  }
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

/** 分享页的握手参数：`/ws?share=<shareId>`，浏览器初连与每次重连都带。 */
export const SHARE_WS_QUERY_PARAM = 'share';

export function shareWsParam(url: URL): string | null {
  return url.searchParams.get(SHARE_WS_QUERY_PARAM)?.trim() || null;
}

/** token 自带 shareId 前缀（`<shareId>.<random>`）；没有参数时据此判定分享是否已结束。 */
export function shareIdOfToken(token: string | null | undefined): string | null {
  return token ? (parseShareToken(token)?.shareId ?? null) : null;
}

export type ShareWsClose = { code: number; reason: string };

/** 分享凭证不可用时的关闭码：分享已结束回 4410，其余（缺失 / 失效 / 绑定别的分享）回 4401。 */
export function shareWsCloseFor(shareId: string | null | undefined): ShareWsClose {
  if (isShareEnded(shareId)) return { code: SHARE_WS_CLOSE_ENDED, reason: 'SHARE_ENDED' };
  return { code: WS_CLOSE_LOGIN_REQUIRED, reason: 'SHARE_LOGIN_REQUIRED' };
}

export type ShareWsAuth =
  | { ok: true; token: string; verified: ShareAccessVerification }
  | { ok: false; close: ShareWsClose };

/**
 * 带 `share=<shareId>` 的握手：只认绑定该 shareId 的分享凭证，绝不回退常规会话。
 * 缺失 / 失效 / 绑定的是别的分享一律拒绝。
 */
export function resolveShareWsAuth(
  token: string | null | undefined,
  shareId: string,
  now?: number
): ShareWsAuth {
  const verified = verifyShareAccessToken(token, now);
  if (token && verified && verified.scope.shareId === shareId) return { ok: true, token, verified };
  return { ok: false, close: shareWsCloseFor(shareId) };
}

/**
 * 分享公开面上残留的死 cookie：响应里顺手清掉，否则浏览器会一直带着它。
 * 本次响应已经在下发 / 清除分享 cookie 时不插手。
 */
export function staleShareCookieName(req: Request, via: string): string | null {
  // 每个本机响应都会走到这里：先用一次 substring 把绝大多数请求挡在解析之外。
  if (!req.headers.get('cookie')?.includes(SHARE_COOKIE_PREFIX)) return null;
  if (!isShareAccessPath(new URL(req.url).pathname, req.method)) return null;
  const token = readShareCookie(req, via);
  if (!token || verifyShareAccessToken(token)) return null;
  return isValidShareCookieVia(via) ? shareCookieName(via) : null;
}
