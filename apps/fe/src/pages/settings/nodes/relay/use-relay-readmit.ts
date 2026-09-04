// 「重新确认成员」：把旧根签的成员记录用当前根重签一遍（`readmit-node`）。
//
// 接入流程里这一步由 `enrollRelay` 自己顺手做掉（远端换发令牌之前），这里是中继状态卡片上的
// 手动入口——根轮换发生在接入之后时，只能靠它把新出现的陈旧成员补上。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { READMIT_CANCELLED, readmitStaleMembers } from '@/node/readmit-members';
import type { RelayFlowDeps } from '@/node/relay-enroll';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 失败文案：先查本族的 key，再退回中继与账号的通用错误表，最后原样显示 code。 */
export function readmitErrorText(t: Translate, code: string): string {
  for (const key of [`nodes.readmit.errors.${code}`, `relay.tenant.errors.${code}`]) {
    const text = t(key, { defaultValue: '' });
    if (text) return text;
  }
  return t(`auth.errors.${code}`, { defaultValue: code });
}

export interface RelayReadmitDeps {
  /** 缺 uid / kdf 参数时这个动作不可用。 */
  flowDeps: RelayFlowDeps | null;
  prompt: CredentialPromptHandle;
  onChanged: () => void;
  setBusy: (value: boolean) => void;
}

export function useRelayReadmit(deps: RelayReadmitDeps): () => Promise<void> {
  const { t } = useTranslation();
  const { flowDeps, prompt, onChanged, setBusy } = deps;

  return useCallback(async () => {
    if (!flowDeps) return;
    setBusy(true);
    try {
      const result = await readmitStaleMembers({ ...flowDeps, prompt });
      if (result.code === READMIT_CANCELLED) return;
      if (result.code)
        toast.error(t('nodes.readmit.failed', { error: readmitErrorText(t, result.code) }));
      else if (result.signed === 0) toast.success(t('nodes.readmit.none'));
      else toast.success(t('nodes.readmit.done', { count: result.signed }));
      onChanged();
    } finally {
      setBusy(false);
    }
  }, [flowDeps, onChanged, prompt, setBusy, t]);
}
