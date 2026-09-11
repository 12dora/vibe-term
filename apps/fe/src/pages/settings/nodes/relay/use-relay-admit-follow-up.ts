// 中继模式下 admit 之后的收尾：给刚加入的节点补发当前世代的 `K_meta`（plan §1.4）。
//
// 为什么不做在 enrollment 引擎里：引擎是 hub / 中继通吃的那条流水线，中继的密钥分发是租户侧
// 的事。这里只订阅引擎已经暴露出来的「刚 admit 成功的 enrollment id」，再按 id 取回证书里的
// node id，补一条 `meta-key {op:'admit'}`。
//
// 签名者取自 admit 刚用过的那把（5 分钟复用窗口）：admit 与补发之间不该再问一次凭据。窗口里
// 没有（用户手动确认后窗口被清、或页面刚打开就收到推送）时不硬签——欠账已经记下，界面上的
// 「成员密钥未送达」告警条会带着重试按钮一直挂着（见 `relay-meta-key-admit.ts`）。
//
// 这个钩子只是**加速路径**：它挂在页面上，页面不开就不跑。欠账的权威来源是
// `GET /api/mesh/relay/status` 的 `metaKeyLagging`，与本标签页的内存状态无关。

import { admittedNodeIdFor, withKeyLogLock } from '@/node/enrollment-engine';
import { refreshMeshRelay } from '@/node/mesh-relay';
import type { RelayFlowDeps, RelayFlowMode } from '@/node/relay-enroll';
import { catchUpMetaKeyLagging, distributeMetaKey } from '@/node/relay-meta-key-admit';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
import type { RelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { defaultRelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { relayErrorText } from './use-relay-actions';

export interface RelayAdmitFollowUpInput {
  /** 只在中继模式下做这件事。 */
  enabled: boolean;
  /** 引擎里已 admit 成功的 enrollment id（`useEnrollmentEngineState().admittedIds`）。 */
  admittedIds: string[];
  api: AuthApi;
  relayApi?: RelayTenantApi;
  mode: RelayFlowMode | null;
}

/**
 * 已经处理过的 enrollment，**宿主级**而不是每个 hook 一份：设置页与「接入更多设备」面板可能
 * 同时挂着，两份各自补发会白白多换一代密钥，而且第二份抢不到复用窗口里的签名者。
 */
const handledAdmits = new Set<string>();

export function useRelayAdmitFollowUp(input: RelayAdmitFollowUpInput): void {
  const { t } = useTranslation();
  const { admittedIds, api, enabled, mode } = input;
  const relayApi = input.relayApi ?? defaultRelayTenantApi;

  useEffect(() => {
    if (!enabled || !mode) return;
    const deps: RelayFlowDeps = { api, relayApi, mode, lock: withKeyLogLock };
    for (const id of admittedIds) {
      // 只挡住「同一条正在飞」；成败由 `relay-meta-key-pending` 记账，失败的那条会被重试回路
      // 或告警条上的「补发成员密钥」接手。
      if (handledAdmits.has(id)) continue;
      handledAdmits.add(id);
      void followUp(deps, relayApi, admittedNodeIdFor(id), t);
    }
  }, [admittedIds, api, enabled, mode, relayApi, t]);
}

/**
 * 补发一条 `meta-key {op:'admit'}`。
 *
 * node id 拿不到时（旧的重发路径没有证书对象）不放弃：改问服务端「现在谁还欠着」，
 * 按那份名单逐台补。无论成败都会刷新一次中继状态，告警条据此上屏。
 */
async function followUp(
  deps: RelayFlowDeps,
  relayApi: RelayTenantApi,
  nodeIdHex: string | null,
  t: (key: string, options?: Record<string, unknown>) => string
): Promise<void> {
  const code = nodeIdHex
    ? await distributeMetaKey(deps, nodeIdHex).then((result) => (result.ok ? null : result.code))
    : await catchUpMetaKeyLagging(deps, null, relayApi).then((summary) => summary.failedCode);
  await refreshMeshRelay(relayApi);
  if (code === null) return;
  // 欠账已经落账，告警条会一直挂着；这里只提示一次，别把用户按在一条 toast 上做决定。
  toast.warning(t('relay.tenant.metaKey.admitFailed', { error: relayErrorText(t, code) }));
}
