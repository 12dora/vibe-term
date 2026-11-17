// 单台节点上的签发：取 login-code challenge → 核对节点公钥 → 签 login → 登记 sha256(节点码)。

import type { AuthApi, AuthChallengeResponse } from '@vibeterm/api-client/auth/index';
import { LOGIN_CODE_CHALLENGE_PURPOSE, type LoginCodeIssueRequest } from '@vibeterm/shared';
import {
  buildLogin,
  bytesEqual,
  decodeBase64url,
  deriveNodeLoginCode,
  encodeBase64url,
  encodeLogin,
  loginCodeHash,
} from '@vibeterm/shared/auth';
import type { LoginCodeProofMaterial } from './login-code-proof';
import { transportFailureCode } from './login-throttle';

export interface LoginCodeIssueTarget {
  api: AuthApi;
  material: LoginCodeProofMaterial;
  secret: Uint8Array;
  target: { meshId: string; runtimeId: string; name: string; publicKey: string };
}

type NodeOutcome =
  | { meshId: string; name: string; ok: true; expiresAt: number }
  | { meshId: string; name: string; ok: false; code: string; retryAfterMs?: number };

/** 老节点没有这条路由。 */
const isMissingRoute = (status: unknown) => status === 404 || status === 405;

function failed(
  target: LoginCodeIssueTarget['target'],
  code: string,
  retryAfterMs?: unknown
): NodeOutcome {
  const row = { meshId: target.meshId, name: target.name, ok: false as const, code };
  return typeof retryAfterMs === 'number' ? { ...row, retryAfterMs } : row;
}

function thrownFailure(target: LoginCodeIssueTarget['target'], err: unknown): NodeOutcome {
  const info = err as { status?: unknown; retryAfterMs?: unknown } | null;
  if (isMissingRoute(info?.status)) return failed(target, 'OUTDATED');
  return failed(target, transportFailureCode(err), info?.retryAfterMs);
}

async function signedBody(
  args: LoginCodeIssueTarget,
  challenge: AuthChallengeResponse,
  targetPk: Uint8Array
): Promise<LoginCodeIssueRequest> {
  const { material, target } = args;
  const login = buildLogin({
    challengeId: challenge.challenge_id,
    nonce: decodeBase64url(challenge.nonce),
    // 与普通登录一致：target 填 `/n/<id>` 用的运行时 id（本机为 'self'），entry 填会话的入口。
    target: target.runtimeId,
    targetPk,
    uid: material.uid,
    entry: material.entry,
  });
  const nodeCode = deriveNodeLoginCode(args.secret, target.meshId);
  try {
    return {
      login: encodeBase64url(encodeLogin(login)),
      sig: encodeBase64url(await material.sign(login)),
      delegation: encodeBase64url(material.delegationBytes),
      delegation_sig: encodeBase64url(material.delegationSig),
      ...(material.totp ? { totp: material.totp } : {}),
      ...(material.passkey ? { passkey: material.passkey } : {}),
      code_hash: encodeBase64url(loginCodeHash(nodeCode)),
    };
  } finally {
    nodeCode.fill(0);
  }
}

export async function issueOnTarget(args: LoginCodeIssueTarget): Promise<NodeOutcome> {
  const { api, material, target } = args;
  let challenge: AuthChallengeResponse;
  try {
    challenge = await api.challenge(target.runtimeId, material.uid, {
      purpose: LOGIN_CODE_CHALLENGE_PURPOSE,
    });
  } catch (err) {
    return thrownFailure(target, err);
  }
  const targetPk = decodeBase64url(challenge.nodePk);
  if (!bytesEqual(targetPk, decodeBase64url(target.publicKey))) {
    return failed(target, 'NODE_PK_MISMATCH');
  }
  let body: LoginCodeIssueRequest;
  try {
    body = await signedBody(args, challenge, targetPk);
  } catch {
    return failed(target, 'SIGN_FAILED');
  }
  try {
    const result = await api.issueLoginCode(target.runtimeId, body);
    if (result.ok)
      return { meshId: target.meshId, name: target.name, ok: true, expiresAt: result.expiresAt };
    if (isMissingRoute(result.status)) return failed(target, 'OUTDATED');
    return failed(target, result.code, result.retryAfterMs);
  } catch (err) {
    return thrownFailure(target, err);
  }
}

/** 固定并发跑完一组任务，结果按输入顺序返回。 */
export async function runLimited<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const lane = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}
