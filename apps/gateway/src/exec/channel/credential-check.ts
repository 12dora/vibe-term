import { isAccessTokenActive } from '../../auth/access-tokens';
import type { NodeSessionStore } from '../../auth/node-session-store';
import type { ExecChannelAuth } from './transport-types';

type SessionVerifier = Pick<NodeSessionStore, 'verify'>;

let sessionVerifier: { store: SessionVerifier; now: () => number } | null = null;

/** 绑定节点会话库，供 HELLO 阶段复核凭证；返回解绑函数（仅在仍是当前绑定时才清除）。 */
export function bindExecSessionVerifier(
  store: SessionVerifier,
  now: () => number = Date.now
): () => void {
  const bound = { store, now };
  sessionVerifier = bound;
  return () => {
    if (sessionVerifier === bound) sessionVerifier = null;
  };
}

/**
 * 通道连接在 HELLO（open / resume）时的凭证复核：令牌须仍有效，依附的节点会话须仍可验证。
 * 读库失败、未绑定会话库一律按无效处理（宁可拒绝一次，也不放行已撤销的凭证）。
 */
export function execCredentialValid(auth: ExecChannelAuth): boolean {
  try {
    if (auth.tokenId !== null && !isAccessTokenActive(auth.tokenId)) return false;
    const ref = auth.session;
    if (!ref) return true;
    if (!sessionVerifier) return false;
    const { store, now } = sessionVerifier;
    return store.verify(ref.sid, { viaNodeId: ref.viaNodeId, now: now() }).ok;
  } catch {
    return false;
  }
}
