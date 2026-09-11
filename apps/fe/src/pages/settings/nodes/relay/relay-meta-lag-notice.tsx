// 「成员密钥未送达」告警条。
//
// 数据源是 `GET /api/mesh/relay/status` 的 `metaKeyLagging`——**服务端按当前 `meta-key` 记录的
// 逐节点封装条目算出来的**，与本标签页记了什么欠账无关。因此换台机器、换浏览器、刷新页面，
// 甚至在手机 PWA 上，看到的都是同一份名单；补发按钮在哪个入口点都一样有效。
//
// 为什么必须有这条：新节点拿不到 `K_meta` 就解不开元数据块——名字与版本一律上报不了，
// 在各处只显示一串 node id，也收不到其它节点的状态。而这件事没有任何自愈路径。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { withKeyLogLock } from '@/node/enrollment-engine';
import { refreshMeshRelay } from '@/node/mesh-relay';
import type { RelayFlowDeps, RelayFlowMode } from '@/node/relay-enroll';
import { catchUpMetaKeyLagging } from '@/node/relay-meta-key-admit';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
import type {
  RelayMetaKeyLaggingNode,
  RelayTenantApi,
} from '@vibeterm/api-client/relay/tenant-api';
import { defaultRelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Notice, NoticeAction } from '../card-parts';
import { relayErrorText } from './use-relay-actions';

/** 名单里前几台的显示名；只有 node id 的取前 8 位，整串 hex 摆在提示里没人读得下去。 */
export function laggingNames(rows: readonly RelayMetaKeyLaggingNode[], limit = 3): string {
  return rows
    .slice(0, limit)
    .map((row) => row.name ?? row.nodeId.slice(0, 8))
    .join('、');
}

export interface RelayMetaLagNoticeProps {
  /** 服务端给出的欠账名单；空数组不渲染任何东西。 */
  lagging: RelayMetaKeyLaggingNode[];
  /** 缺 uid / kdf 参数（还没有主用户）时补发不可用。 */
  mode: RelayFlowMode | null;
  api: AuthApi;
  prompt: CredentialPromptHandle;
  relayApi?: RelayTenantApi;
  /** 补发之后重新拉一次状态与节点列表。 */
  onChanged: () => void;
}

export function RelayMetaLagNotice({
  lagging,
  mode,
  api,
  prompt,
  relayApi = defaultRelayTenantApi,
  onChanged,
}: RelayMetaLagNoticeProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const resend = useCallback(async () => {
    if (!mode) return;
    setBusy(true);
    try {
      const deps: RelayFlowDeps = { api, relayApi, mode, lock: withKeyLogLock };
      const summary = await prompt.withSigner(
        (signer) => catchUpMetaKeyLagging(deps, signer, relayApi),
        { purpose: 'admit' }
      );
      if (!summary) return;
      if (summary.failedCode === null) {
        toast.success(t('relay.tenant.metaKey.lagging.done', { count: summary.delivered }));
      } else {
        toast.error(
          t('relay.tenant.metaKey.lagging.failed', {
            error: relayErrorText(t, summary.failedCode),
          })
        );
      }
      // 名单本身来自 `/api/mesh/relay/status`，补完必须自己重拉一次，
      // 否则告警条要等下一拍 30 秒轮询才会消失。
      await refreshMeshRelay(relayApi);
      onChanged();
    } finally {
      setBusy(false);
    }
  }, [api, mode, onChanged, prompt, relayApi, t]);

  if (lagging.length === 0) return null;
  return (
    <Notice
      tone="warning"
      testId="nodes-relay-meta-lagging"
      action={
        <NoticeAction
          label={t('relay.tenant.metaKey.lagging.action')}
          testId="nodes-relay-meta-lagging-action"
          disabled={busy || !mode}
          onClick={() => void resend()}
        />
      }
    >
      {t('relay.tenant.metaKey.lagging.notice', {
        count: lagging.length,
        names: laggingNames(lagging),
      })}
    </Notice>
  );
}
