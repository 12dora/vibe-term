// 中继模式下 admit 之后的收尾：给刚加入的节点补发当前世代的 `K_meta`（plan §1.4）。
//
// 为什么不做在 enrollment 引擎里：引擎是 hub / 中继通吃的那条流水线，中继的密钥分发是租户侧
// 的事。这里只订阅引擎已经暴露出来的「刚 admit 成功的 enrollment id」，再按 id 取回证书里的
// node id，补一条 `meta-key {op:'admit'}`。
//
// 签名者取自 admit 刚用过的那把（5 分钟复用窗口）：admit 与补发之间不该再问一次凭据。窗口里
// 没有（用户手动确认后窗口被清、或页面刚打开就收到推送）时不硬签，只提示改走「轮换元数据密钥」。

import { leaseSigner, takeRememberedSigner } from '@/auth/credential-prompt';
import { admittedNodeIdFor, withKeyLogLock } from '@/node/enrollment-engine';
import type { RelayFlowMode } from '@/node/relay-enroll';
import { appendMetaKey } from '@/node/relay-enroll';
import type { AuthApi } from '@tmex/api-client/auth/index';
import type { RelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import { defaultRelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import { useEffect, useRef } from 'react';
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

export function useRelayAdmitFollowUp(input: RelayAdmitFollowUpInput): void {
  const { t } = useTranslation();
  // 每条 enrollment 只补发一次：`admittedIds` 是累积数组，重渲染会把整段再看一遍。
  const handled = useRef<Set<string>>(new Set());
  const { admittedIds, api, enabled, mode } = input;
  const relayApi = input.relayApi ?? defaultRelayTenantApi;

  useEffect(() => {
    if (!enabled || !mode) return;
    for (const id of admittedIds) {
      if (handled.current.has(id)) continue;
      handled.current.add(id);
      const nodeIdHex = admittedNodeIdFor(id);
      // 重发路径手上只有已签字节、没有证书，拿不到 node id：只能靠轮换补。
      if (!nodeIdHex) {
        toast.warning(t('relay.tenant.metaKey.needsRotate'));
        continue;
      }
      void distributeMetaKey({ api, relayApi, mode, nodeIdHex, t });
    }
  }, [admittedIds, api, enabled, mode, relayApi, t]);
}

async function distributeMetaKey(input: {
  api: AuthApi;
  relayApi: RelayTenantApi;
  mode: RelayFlowMode;
  nodeIdHex: string;
  t: (key: string, options?: Record<string, unknown>) => string;
}): Promise<void> {
  const signer = takeRememberedSigner(Date.now());
  if (!signer) {
    toast.warning(input.t('relay.tenant.metaKey.needsRotate'));
    return;
  }
  // 租约罩住整段：复用窗口到期的定时器不能在签名途中把根钥 seed 抹成 0。
  const release = leaseSigner(signer);
  try {
    const result = await appendMetaKey(
      { api: input.api, relayApi: input.relayApi, mode: input.mode, lock: withKeyLogLock },
      { op: 'admit', node_id: input.nodeIdHex },
      signer
    );
    if (!result.ok) {
      toast.warning(
        input.t('relay.tenant.metaKey.admitFailed', {
          error: relayErrorText(input.t, result.code),
        })
      );
    }
  } finally {
    release();
  }
}
