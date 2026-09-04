// 中继的两笔「欠账」及其重试：没落账的 `meta-key` 换代，与没重封的密封包。
//
// 两者都要一次凭据才能补：换代要一把签名者（根密码或通行密钥皆可），重封只能用密码
// （KEK 由根种子派生，通行密钥断言给不出种子）。从 `use-relay-actions.ts` 拆出来，
// 那边只管接入 / 离开 / 轮换三个主动作。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { RelayFlowDeps } from '@/node/relay-enroll';
import {
  type PendingMetaKey,
  forgetRelayPackDebt,
  listPendingMetaKeys,
  relayPackDebtDetail,
  retryPendingMetaKeys,
  subscribePendingMetaKeys,
  subscribeRelayPackDebt,
} from '@/node/relay-meta-key-pending';
import type { RelayPackRefreshOutcome } from '@/node/relay-pack';
import { refreshRelayPackForSigner } from '@/node/relay-pack';
import type { AuthApi } from '@tmex/api-client/auth/index';
import type { RelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import { useCallback, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

export interface RelayPendingController {
  /** 还没落账的 `meta-key` 换代；非空时页面必须一直挂着告警。 */
  metaPending: PendingMetaKey[];
  /** 手动重试欠账（需要一次凭据）。 */
  retryMetaKey: () => Promise<void>;
  /** 中继上的密封包还没刷新（改密之后最典型）：别的机器暂时无法用密码加入。 */
  packPending: boolean;
  /** 手动重封密封包（须用密码，通行密钥给不出根种子）。 */
  retryPack: () => Promise<void>;
}

export interface RelayPendingDeps {
  api: AuthApi;
  relayApi: RelayTenantApi;
  /** 缺 uid / kdf 参数时换代重试不可用（重封密封包不吃这份身份）。 */
  flowDeps: RelayFlowDeps | null;
  prompt: CredentialPromptHandle;
  onChanged: () => void;
  setBusy: (value: boolean) => void;
}

export function useRelayPending(deps: RelayPendingDeps): RelayPendingController {
  const { t } = useTranslation();
  const { api, relayApi, flowDeps, prompt, onChanged, setBusy } = deps;

  const metaPending = useSyncExternalStore(
    subscribePendingMetaKeys,
    listPendingMetaKeys,
    listPendingMetaKeys
  );

  const retryMetaKey = useCallback(async () => {
    if (!flowDeps) return;
    setBusy(true);
    try {
      const left = await prompt.withSigner((signer) => retryPendingMetaKeys(flowDeps, signer), {
        purpose: 'revoke',
      });
      if (left === null) return;
      if (left === 0) {
        toast.success(t('relay.tenant.metaKey.done'));
        onChanged();
        return;
      }
      toast.error(t('relay.tenant.metaKey.retryFailed'));
    } finally {
      setBusy(false);
    }
  }, [flowDeps, onChanged, prompt, setBusy, t]);

  const packDebt = useSyncExternalStore(
    subscribeRelayPackDebt,
    relayPackDebtDetail,
    relayPackDebtDetail
  );
  const packPending = packDebt.all || packDebt.urls.length > 0;

  const retryPack = useCallback(async () => {
    setBusy(true);
    // 欠账明确到某几台就只重封那几台；`all` 是「哪几台不明」，整份重封。
    const urls = packDebt.all ? undefined : packDebt.urls;
    try {
      const outcome = await prompt.withSigner<RelayPackRefreshOutcome | 'needs-password'>(
        (signer) =>
          signer.kind === 'root'
            ? refreshRelayPackForSigner(signer, { api, relayApi, ...(urls ? { urls } : {}) })
            : 'needs-password',
        { purpose: 'enroll' }
      );
      if (outcome === null) return;
      if (outcome === 'needs-password') {
        toast.error(t('relay.tenant.pack.needsPassword'));
        return;
      }
      if (outcome === 'failed') {
        toast.error(t('relay.tenant.pack.retryFailed'));
        return;
      }
      // `skipped` = 本机压根不走中继，没有密封包这回事，同样该销账。
      forgetRelayPackDebt();
      toast.success(t('relay.tenant.pack.done'));
      onChanged();
    } finally {
      setBusy(false);
    }
  }, [api, onChanged, packDebt, prompt, relayApi, setBusy, t]);

  return { metaPending, retryMetaKey, packPending, retryPack };
}
