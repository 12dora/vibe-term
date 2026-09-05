import { SHARE_WS_CLOSE_ENDED } from '@tmex/shared/share';
import type { NodeSessionStore } from '../auth/node-session-store';
import { isAuthLoginPublicPath, isShareAccessPath } from './auth-public-paths';
import { SHARE_WS_VERIFY_MS } from './mesh-deps';
import {
  type ShareAccessVerification,
  parseShareAuth,
  shareCookieName,
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
};

export type StreamAuthResult = StreamAuthOk | { ok: false; reason: string };

export function isAuthSkippedPath(path: string): boolean {
  const bare = path.split('?')[0] ?? path;
  return isAuthLoginPublicPath(bare) || bare.startsWith('/api/mesh-internal/');
}

export function verifyStreamAuth(
  auth: string | null | undefined,
  path: string,
  ctx: StreamAuthContext
): StreamAuthResult {
  const now = ctx.now?.() ?? Date.now();
  const shareToken = parseShareAuth(auth);
  if (shareToken) {
    const share = verifyShareAccessToken(shareToken, now);
    if (!share) return { ok: false, reason: 'share_invalid' };
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
 * HTTP 流的鉴权：常规会话照旧；分享凭证只放行 `/api/share-access/*`，
 * 并把 token 以 `tmex_sh_<peerNodeId>` cookie 合成回请求头，供分享路由读取。
 */
export function authorizeHttpStream(
  auth: string | null | undefined,
  pathname: string,
  ctx: StreamAuthContext,
  headers: Record<string, string>
): StreamAuthResult {
  const verified = verifyStreamAuth(auth, pathname, ctx);
  if (!verified.ok || !verified.share) return verified;
  if (!isShareAccessPath(pathname)) return { ok: false, reason: 'share_forbidden' };
  headers.cookie = `${shareCookieName(ctx.peerNodeId)}=${verified.share.token}`;
  return verified;
}

/**
 * ws 流的逐帧凭证复验：常规会话每帧校验，分享凭证按 SHARE_WS_VERIFY_MS 复验。
 * 返回非空即 RST reason（分享用终止性关闭码编码，Hub 透传给浏览器）。
 */
export function createStreamRecheck(
  sid: string,
  share: StreamShareAuth | undefined,
  ctx: StreamAuthContext
): () => string | null {
  if (!share) {
    return () => {
      const check = ctx.sessionStore.verify(sid, {
        viaNodeId: ctx.peerNodeId,
        now: ctx.now?.() ?? Date.now(),
      });
      return check.ok ? null : check.reason;
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
