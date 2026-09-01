// 「生成加入码」的唯一实现：设置页的节点管理区块与「接入更多设备」面板共用同一份逻辑。
//
// `enroll_sk` 只存在于浏览器与 join 串里，**不经过 hub**；join 串只显示这一次，
// admit / 取消 / 过期后立刻从 state 里消失，消费方据此把它移出 DOM。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { headFromResponse } from '@/auth/key-log-actions';
import {
  type CreatedEnrollment,
  createEnrollmentOnHub,
  isTrustedHubUrl,
  requireRootPublicKey,
} from '@/node/enrollment';
import type { HubApi } from '@/node/hub-api';
import type { AuthApi } from '@tmex/api-client/auth/index';
import { requireRootEpoch } from '@tmex/api-client/auth/index';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { actionErrorText } from './errors';
import type { ResolvedMode } from './types';

/** 引用稳定的空数组：没有外部清理源的消费方不必每次渲染都换一个新数组。 */
const NO_CLEARED_IDS: string[] = [];

export interface UseCreateEnrollmentInput {
  api: AuthApi;
  /** 缺 uid / kdf 参数（还没有主用户）时为 `null`：不发起创建，直接报未知用户。 */
  mode: ResolvedMode | null;
  hubApi: HubApi | null;
  prompt: CredentialPromptHandle;
  /** 已 admit / 已过期 / 已取消的 pending id：对应的 join 串必须立刻消失。 */
  clearedIds?: string[];
  /** writer hub 的对外地址；hub 以 `HUB_NOT_WRITER` 拒写时靠它指路。 */
  writerPublicUrl?: string | null;
}

export interface CreateEnrollmentState {
  name: string;
  setName: (value: string) => void;
  busy: boolean;
  error: string | null;
  /** 刚创建出来的 enrollment；join 串只在内存里、只显示这一次。 */
  created: CreatedEnrollment | null;
  /** join 命令里的 hub 对外地址；缺失或不可信时为 `null`，此时不能编命令。 */
  hubUrl: string | null;
  submit: () => Promise<void>;
}

export function useCreateEnrollment(input: UseCreateEnrollmentInput): CreateEnrollmentState {
  const { api, mode, hubApi, prompt, writerPublicUrl = null } = input;
  const clearedIds = input.clearedIds ?? NO_CLEARED_IDS;
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedEnrollment | null>(null);

  useEffect(() => {
    if (created && clearedIds.includes(created.pending.hubEnrollmentId)) setCreated(null);
  }, [clearedIds, created]);

  // 过期即自清：没有外部清理源的消费方（侧滑面板）也不能把过期的 join 串继续留在 DOM 里。
  useEffect(() => {
    if (!created) return;
    const timer = setTimeout(
      () => setCreated(null),
      Math.max(0, created.pending.exp - Date.now()) + 1
    );
    return () => clearTimeout(timer);
  }, [created]);

  const submit = useCallback(async () => {
    setError(null);
    if (!mode) {
      setError(t('auth.errors.UNKNOWN_USER'));
      return;
    }
    if (!hubApi) {
      setError(t('nodes.hubOffline'));
      return;
    }
    setBusy(true);
    try {
      const rootEpoch = requireRootEpoch(mode);
      // 根公钥来自服务端：passkey 签授权时浏览器手里根本没有根钥，join 串第二段只能靠它。
      const rootPublicKey = requireRootPublicKey(mode);
      // 设计 §2 步骤 3：这次交互进 5 分钟窗口，随后的 admit-node 自动复用，不再打扰用户。
      const signer = await prompt.request({ purpose: 'enroll' });
      if (!signer) return;
      const head = await api.keyLogHead();
      const outcome = await createEnrollmentOnHub({
        hubApi,
        uid: mode.uid,
        rootEpoch,
        signer,
        rootPublicKey,
        keyLogHeadHash: headFromResponse(head).hash,
        name,
      });
      setCreated(outcome);
      setName('');
    } catch (err) {
      // 走到这里说明 enrollment 没建成（多半是 hub 请求失败）：复用窗口里的根钥没有任何
      // 后续动作会用到，立刻清零，不要等 5 分钟定时器（见 F4-fix 评审 Major「所有权式清零」）。
      prompt.forget();
      setError(actionErrorText(t, err, { writerPublicUrl }));
    } finally {
      setBusy(false);
    }
  }, [api, hubApi, mode, name, prompt, t, writerPublicUrl]);

  return {
    name,
    setName,
    busy,
    error,
    created,
    hubUrl: resolveHubPublicUrl(created, mode ?? {}),
    submit,
  };
}

/**
 * join 命令里的 hub 地址：**只**来自 hub —— enrollment 创建响应的 `public_url`，
 * 或 `/api/auth/mode` 的 `hubPublicUrl`。两者都没有、或值不是可信 https URL 就不生成命令：
 * 它会被原样拼进一条让用户粘贴执行的 shell 命令，畸形值等于命令注入（见 F4-fix 评审 Major）。
 */
export function resolveHubPublicUrl(
  created: { hubPublicUrl: string | null } | null,
  mode: { hubPublicUrl?: string | null }
): string | null {
  const url = created?.hubPublicUrl ?? mode.hubPublicUrl ?? null;
  return isTrustedHubUrl(url) ? url : null;
}
