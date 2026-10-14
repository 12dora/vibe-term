import {
  TOKEN_CREDENTIAL_PREFIX,
  authenticateTokenSecret,
  readTokenCredentialSecret,
} from '../auth/access-token-auth';
import type { NodeSessionStore } from '../auth/node-session-store';
import type { ExecSessionRef } from '../exec/channel/transport-types';
import { parseShareAuth } from './share-credential';
import { tokenClientIp } from './stream-token-auth';

export const EXEC_TOKEN_CREDENTIAL_PREFIX = TOKEN_CREDENTIAL_PREFIX;

export type ExecCredentialContext = {
  peerNodeId: string;
  sessionStore: NodeSessionStore;
  now?: () => number;
  /** 入口随 OPEN 带来的真实客户端 IP（令牌使用记录用）；缺省记为对端节点。 */
  clientIp?: string;
};

export type ExecCredentialResult =
  | { ok: true; uid: string; tokenId: string | null; session?: ExecSessionRef }
  | { ok: false; reason: string };

/**
 * exec 流的凭证校验。节点会话 sid 的规则与 `verifyStreamAuth` 一致（`viaNodeId = peerNodeId`），
 * 但不接受分享凭证，也没有公开路径的匿名放行。
 */
export function verifyExecCredential(
  credential: unknown,
  ctx: ExecCredentialContext
): ExecCredentialResult {
  if (typeof credential !== 'string' || !credential) return { ok: false, reason: 'missing auth' };
  if (credential.startsWith(EXEC_TOKEN_CREDENTIAL_PREFIX)) {
    return verifyTokenCredential(credential, ctx);
  }
  if (parseShareAuth(credential)) return { ok: false, reason: 'share_forbidden' };
  const result = ctx.sessionStore.verify(credential, {
    viaNodeId: ctx.peerNodeId,
    now: ctx.now?.() ?? Date.now(),
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  return {
    ok: true,
    uid: result.session.userId,
    tokenId: null,
    session: { sid: credential, viaNodeId: ctx.peerNodeId },
  };
}

/** exec 通道只收带 `exec` 作用域的令牌；失败原因对外只有「无效」和「作用域不足」两种。 */
function verifyTokenCredential(
  credential: string,
  ctx: ExecCredentialContext
): ExecCredentialResult {
  const principal = authenticateTokenSecret(
    readTokenCredentialSecret(credential),
    tokenClientIp(ctx.clientIp, ctx.peerNodeId)
  );
  if (!principal) return { ok: false, reason: 'token_invalid' };
  if (!principal.scopes.includes('exec')) return { ok: false, reason: 'token_scope' };
  return { ok: true, uid: principal.userId, tokenId: principal.tokenId };
}
