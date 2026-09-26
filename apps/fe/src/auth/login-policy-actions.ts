// 「登录限制」写入：签一条 `login-policy` 密钥日志记录并提交，与多节点通知同一条路：
// 取 head → 签名 → append，整段进 key log 写锁（head 是全局的，并行会造出两条同 seq 的记录）。

import { type RecordSigner, buildSignedRecord, headFromResponse } from '@/auth/key-log-actions';
import { withKeyLogLock } from '@/node/enrollment-engine';
import { warnRelayAckGlobal } from '@/node/relay-ack';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
import { requireRootEpoch } from '@vibeterm/api-client/auth/index';
import { errorMessage } from '@vibeterm/shared';
import { type LoginPolicy, encodeBase64url, encodeLoginPolicy } from '@vibeterm/shared/auth';

/** 记录送出去了，但本机没确认落库（可原样重来）。 */
export const LOGIN_POLICY_UNCONFIRMED = 'LOGIN_POLICY_UNCONFIRMED';

export type LoginPolicyWriteResult = { ok: true } | { ok: false; code: string };

export interface LoginPolicyWriteDeps {
  api: AuthApi;
  mode: { uid: string; rootEpoch?: number | null };
  lock?: <T>(run: () => Promise<T>) => Promise<T>;
}

export async function setLoginPolicyViaKeyLog(
  deps: LoginPolicyWriteDeps,
  policy: LoginPolicy,
  signer: RecordSigner
): Promise<LoginPolicyWriteResult> {
  const lock = deps.lock ?? withKeyLogLock;
  try {
    const rootEpoch = requireRootEpoch(deps.mode);
    const payload = encodeLoginPolicy(policy);
    return await lock(async () => {
      const head = headFromResponse(await deps.api.keyLogHead());
      const record = await buildSignedRecord({
        head,
        rootEpoch,
        uid: deps.mode.uid,
        type: 'login-policy',
        payload,
        signer,
      });
      const appended = await deps.api.appendKeyLog(
        { bytes: encodeBase64url(record.bytes), sig: encodeBase64url(record.sig) },
        { hubSync: true }
      );
      if (!appended.ok) return { ok: false as const, code: appended.code };
      if (appended.hubAck === false) {
        return { ok: false as const, code: appended.hubError || LOGIN_POLICY_UNCONFIRMED };
      }
      warnRelayAckGlobal(appended);
      return { ok: true as const };
    });
  } catch (err) {
    return { ok: false, code: errorMessage(err) };
  }
}
