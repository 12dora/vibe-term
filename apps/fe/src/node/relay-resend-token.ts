// 重发中继令牌：把当前租户令牌原样再封一遍给全体成员（`set-relays`）。
//
// 用途只有一个——令牌换发那一刻正好离线的成员错过了上一条记录，回来时手里还是旧令牌。
// 中继侧的历史令牌宽限是有限的（三代 / 30 天），在宽限内补一条记录，成员一上线就能追上。
//
// 两条硬性质：
// - **必须检查 `relayAck`**：本条记录只有落到中继上才轮得到成员下载。`hub=sync` 在中继模式下
//   仍会先本地落库再发布，发布失败不会让请求变成 4xx——只报成功等于让人以为已经救回来了
//   （E2 审计 F3）。所以 `relayAck === false` 一律当失败上报，并保持可重试。
// - `prepare → 取 head → 签名 → 提交` 全程一把 key log 写锁：与 admit / revoke 抢同一个头。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { RecordSigner } from '@/auth/key-log-actions';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { RELAY_ACK_UNKNOWN, relayAckErrorText } from './relay-ack';
import type { RelayFlowDeps } from './relay-enroll';
import { relayFlowFailure, signAndSubmitRelayRecord } from './relay-enroll';

/** 中继收下了记录，但没确认（成员拿不到新令牌）。 */
export const RELAY_TOKEN_NOT_ACKED = 'RELAY_TOKEN_NOT_ACKED';

export type RelayResendTokenResult =
  | {
      ok: true;
      /** 这一条覆盖的成员节点数。 */
      nodes: number;
    }
  | {
      ok: false;
      code: string;
      /** 上联给出的原始错误（仅 `RELAY_TOKEN_NOT_ACKED` 时有）。 */
      relayError?: string;
    };

/**
 * 重发一次令牌。签名者可以是根密码或通行密钥（与吊销同一档：只签一条密钥日志记录）。
 *
 * 失败一律可原样重来：prepare 每次都会算一份新的封装，重复提交不会把上级顶成 `seq_gap`。
 */
export function resendRelayToken(
  deps: RelayFlowDeps,
  signer: RecordSigner
): Promise<RelayResendTokenResult> {
  return deps.lock(async () => {
    let prepared: { payload: string; nodes: number };
    try {
      prepared = await deps.relayApi.resendTokenPrepare();
    } catch (err) {
      return asFailure(relayFlowFailure(err));
    }
    const result = await signAndSubmitRelayRecord(deps, {
      type: 'set-relays',
      payload: prepared.payload,
      signer,
      // 这条路径把「中继没确认」当失败报，不要再叠一条通用告警。
      quietRelayAck: true,
    });
    if (!result.ok) return asFailure(result);
    // 落了本机但没上中继：成员一条都收不到，这次重发等于没做。
    if (result.relayAck === false) {
      return {
        ok: false,
        code: RELAY_TOKEN_NOT_ACKED,
        ...(result.relayError ? { relayError: result.relayError } : {}),
      };
    }
    return { ok: true, nodes: prepared.nodes };
  });
}

function asFailure(result: { ok: boolean; code?: string }): RelayResendTokenResult {
  return { ok: false, code: result.code ?? 'UNKNOWN' };
}

// ---------------------------------------------------------------------------
// React 绑定
// ---------------------------------------------------------------------------

export interface RelayResendTokenDeps {
  /** 缺 uid / kdf 参数时这个动作不可用。 */
  flowDeps: RelayFlowDeps | null;
  prompt: Pick<CredentialPromptHandle, 'withSigner'>;
  onChanged: () => void;
  setBusy: (value: boolean) => void;
}

/**
 * 「重发中继令牌」按钮的动作。与 `useRelayReadmit` 同一套形状：一次凭据、一条 toast、
 * 完事重拉状态。凭据走 `withSigner`（不进复用窗口）——这是一次会改变成员解密能力的写入。
 */
export function useRelayResendToken(deps: RelayResendTokenDeps): () => Promise<void> {
  const { t } = useTranslation();
  const { flowDeps, prompt, onChanged, setBusy } = deps;

  return useCallback(async () => {
    if (!flowDeps) return;
    setBusy(true);
    try {
      const result = await prompt.withSigner((signer) => resendRelayToken(flowDeps, signer), {
        purpose: 'revoke',
      });
      if (result === null) return;
      if (result.ok) {
        toast.success(t('relay.tenant.resendToken.done', { nodes: result.nodes }));
        onChanged();
        return;
      }
      if (result.code === RELAY_TOKEN_NOT_ACKED) {
        // 记录只落了本机：成员收不到，按钮保持可用，用户重试即可。
        toast.error(
          t('relay.tenant.resendToken.notAcked', {
            error: relayAckErrorText(t, result.relayError || RELAY_ACK_UNKNOWN),
          })
        );
        return;
      }
      toast.error(t('relay.tenant.resendToken.failed', { error: resendErrorText(t, result.code) }));
    } finally {
      setBusy(false);
    }
  }, [flowDeps, onChanged, prompt, setBusy, t]);
}

/** 失败文案：先查中继自己的错误表，查不到退回通用的 `auth.errors.*`，最后原样显示 code。 */
function resendErrorText(
  t: (key: string, options?: Record<string, unknown>) => string,
  code: string
): string {
  const text = t(`relay.tenant.errors.${code}`, { defaultValue: '' });
  return text || t(`auth.errors.${code}`, { defaultValue: code });
}
