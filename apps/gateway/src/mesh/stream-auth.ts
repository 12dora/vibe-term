import {
  CLEAR_SHARE_HEADER,
  SESSION_RENEWED_HEADER,
  SET_SHARE_HEADER,
  assignHeaderPair,
  readHeaderPairFromRecord,
} from '@vibeterm/shared/http/mesh-headers';
import { SHARE_WS_CLOSE_ENDED } from '@vibeterm/shared/share';
import type { NodeSessionStore } from '../auth/node-session-store';
import { isAuthLoginPublicPath, isShareAccessPath } from './auth-public-paths';
import { SHARE_WS_VERIFY_MS } from './mesh-deps';
import { sessionVerifyDeadline, sessionVerifyDue } from './session-verify-window';
import {
  type ShareAccessVerification,
  legacyShareCookieName,
  parseShareAuth,
  shareCookieName,
  shareIdOfToken,
  shareWsCloseFor,
  verifyShareAccessToken,
} from './share-credential';
import { encodeTerminalStreamClose } from './stream-close-code';

export type StreamAuthContext = {
  peerNodeId: string;
  sessionStore: NodeSessionStore;
  now?: () => number;
};

export type StreamShareAuth = ShareAccessVerification & { token: string };

export type StreamAuthOk = {
  ok: true;
  uid: string | null;
  renewedExpiresAt?: number;
  /** 有值即分享凭证：uid 恒为 null，只允许被分享人的公开面。 */
  share?: StreamShareAuth;
  /** 分享凭证已失效但请求落在分享公开面：降级为匿名，并让响应清掉这枚死 cookie。 */
  clearShare?: boolean;
};

export type StreamAuthFail = {
  ok: false;
  reason: string;
  /** ws 流用的终止性关闭码（4401 / 4410），Hub 解码后直接透给浏览器，不再 failover。 */
  wsClose?: string;
};

export type StreamAuthResult = StreamAuthOk | StreamAuthFail;

export function isAuthSkippedPath(path: string, method?: string): boolean {
  const bare = path.split('?')[0] ?? path;
  return isAuthLoginPublicPath(bare, method) || bare.startsWith('/api/mesh-internal/');
}

/** 分享凭证不可用：分享已结束回 4410，其余回 4401，两者都是终止码（Hub 不再切链路）。 */
function shareAuthFailure(shareId: string | null): StreamAuthFail {
  const close = shareWsCloseFor(shareId);
  return {
    ok: false,
    reason: close.code === SHARE_WS_CLOSE_ENDED ? 'share_ended' : 'share_invalid',
    wsClose: encodeTerminalStreamClose(close.code, close.reason),
  };
}

/**
 * `boundShareId` 来自握手的 `?share=<id>`：给了就必须是分享凭证且绑定同一个分享，
 * 常规会话一律不接受（否则浏览器里残留的 sid 会把分享页升级成全权限连接）。
 */
export function verifyStreamAuth(
  auth: string | null | undefined,
  path: string,
  ctx: StreamAuthContext,
  boundShareId?: string | null
): StreamAuthResult {
  const now = ctx.now?.() ?? Date.now();
  const shareToken = parseShareAuth(auth);
  if (boundShareId && !shareToken) return shareAuthFailure(boundShareId);
  if (shareToken) {
    const share = verifyShareAccessToken(shareToken, now);
    if (!share) return shareAuthFailure(boundShareId ?? shareIdOfToken(shareToken));
    if (boundShareId && share.scope.shareId !== boundShareId) return shareAuthFailure(boundShareId);
    return { ok: true, uid: null, share: { ...share, token: shareToken } };
  }
  const skipped = isAuthSkippedPath(path);
  // 公开路径无 token 直接匿名放行；带了 token 仍照常校验，让 /api/auth/mode 之类能识别已登录会话。
  if (!auth) return skipped ? { ok: true, uid: null } : { ok: false, reason: 'missing auth' };
  const result = ctx.sessionStore.verify(auth, { viaNodeId: ctx.peerNodeId, now });
  if (!result.ok) return skipped ? { ok: true, uid: null } : { ok: false, reason: result.reason };
  return {
    ok: true,
    uid: result.session.userId,
    ...(result.renewedExpiresAt !== undefined ? { renewedExpiresAt: result.renewedExpiresAt } : {}),
  };
}

/**
 * HTTP 流的鉴权：常规会话照旧；分享凭证只放行契约里的三个 `/api/share-access/*` 端点，
 * 并把 token 以 `vibeterm_sh_<peerNodeId>` / `tmex_sh_<peerNodeId>` cookie 合成回请求头，供分享路由读取。
 * 失效的分享凭证落在这三个端点上时降级为匿名——否则残留 cookie 会把查询、
 * 重新登录和退出一起锁死，页面再也自愈不了。
 */
export function authorizeHttpStream(
  auth: string | null | undefined,
  method: string,
  pathname: string,
  ctx: StreamAuthContext,
  headers: Record<string, string>
): StreamAuthResult {
  const publicShare = isShareAccessPath(pathname, method);
  const verified = verifyStreamAuth(auth, pathname, ctx);
  if (!verified.ok) {
    if (!publicShare || !parseShareAuth(auth)) return verified;
    return { ok: true, uid: null, clearShare: true };
  }
  if (!verified.share) return verified;
  if (!publicShare) return { ok: false, reason: 'share_forbidden' };
  headers.cookie = `${shareCookieName(ctx.peerNodeId)}=${verified.share.token}; ${legacyShareCookieName(ctx.peerNodeId)}=${verified.share.token}`;
  return verified;
}

/**
 * ws 流的凭证复验：常规会话最长按 WS_SESSION_VERIFY_MS 复验（与浏览器直连的 `touchSocket`
 * 同一个节奏），但窗口不越过会话自身的过期时刻，TTL / 硬过期不会被节流拖软；分享凭证按
 * SHARE_WS_VERIFY_MS。逐帧走一次 SQLite 事务（还可能带续期 UPDATE）会让每一次击键都压一次库，
 * 终端输入越密开销越大。挂上后的第一帧仍然必校验。
 * 返回非空即 RST reason（分享用终止性关闭码编码，Hub 透传给浏览器）。
 */
export function createStreamRecheck(
  sid: string,
  share: StreamShareAuth | undefined,
  ctx: StreamAuthContext
): () => string | null {
  if (!share) {
    const verifyWindow = { lastVerifyAt: 0, nextVerifyAt: 0 };
    return () => {
      const now = ctx.now?.() ?? Date.now();
      if (!sessionVerifyDue(verifyWindow, now)) return null;
      const check = ctx.sessionStore.verify(sid, { viaNodeId: ctx.peerNodeId, now });
      if (!check.ok) return check.reason;
      verifyWindow.lastVerifyAt = now;
      verifyWindow.nextVerifyAt = sessionVerifyDeadline(check.session, now);
      return null;
    };
  }
  let lastVerifyAt = ctx.now?.() ?? Date.now();
  return () => {
    const now = ctx.now?.() ?? Date.now();
    if (now - lastVerifyAt < SHARE_WS_VERIFY_MS) return null;
    lastVerifyAt = now;
    if (verifyShareAccessToken(share.token, now)) return null;
    return encodeTerminalStreamClose(SHARE_WS_CLOSE_ENDED, 'SHARE_ENDED');
  };
}

/** 会话续期头 + 死分享 cookie 的清除头；后者不能盖掉本次刚下发的新凭证。 */
export function authResponseHeaders(
  headers: Record<string, string>,
  verified: StreamAuthOk
): Record<string, string> {
  if (verified.renewedExpiresAt !== undefined) {
    assignHeaderPair(headers, SESSION_RENEWED_HEADER, String(verified.renewedExpiresAt));
  }
  if (verified.clearShare && !readHeaderPairFromRecord(headers, SET_SHARE_HEADER)) {
    assignHeaderPair(headers, CLEAR_SHARE_HEADER, '1');
  }
  return headers;
}
