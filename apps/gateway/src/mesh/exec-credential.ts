import type { NodeSessionStore } from '../auth/node-session-store';
import { parseShareAuth } from './share-credential';

export const EXEC_TOKEN_CREDENTIAL_PREFIX = 'tok:';

export type ExecCredentialContext = {
  peerNodeId: string;
  sessionStore: NodeSessionStore;
  now?: () => number;
};

export type ExecCredentialResult =
  | { ok: true; uid: string; tokenId: string | null }
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
  if (credential.startsWith(EXEC_TOKEN_CREDENTIAL_PREFIX)) return verifyTokenCredential();
  if (parseShareAuth(credential)) return { ok: false, reason: 'share_forbidden' };
  const result = ctx.sessionStore.verify(credential, {
    viaNodeId: ctx.peerNodeId,
    now: ctx.now?.() ?? Date.now(),
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, uid: result.session.userId, tokenId: null };
}

function verifyTokenCredential(): ExecCredentialResult {
  return { ok: false, reason: 'unsupported' };
}
