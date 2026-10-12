// 中继模式下加入的第二步：给刚加入的节点补发当前世代的 `K_meta`（plan §1.4）。
//
// 为什么不做在 enrollment 引擎里：引擎是 enrollment 通吃的那条流水线，中继的密钥分发是租户侧
// 的事。这里把它做成一个 `AdmitFollowUp` 交给引擎：引擎在 `admit-node` 落账后紧接着调它，
// 两条记录对用户是同一次「确认加入」（见 `admit-progress.ts`）。
//
// 签名者默认取自 admit 刚用过的那把（5 分钟复用窗口）：根钥用户不会被再问一次；passkey 每条
// 记录各要一次仪式，确认按钮旁与凭据框里都事先说明。窗口里没有时不硬签——欠账已经记下，
// 结果行带着补发按钮（见 `relay-meta-key-admit.ts`）。
//
// 欠账的权威来源是 `GET /api/mesh/relay/status` 的 `metaKeyLagging`，与本标签页的内存状态无关。

import type { RecordSigner } from '@/auth/key-log-actions';
import type { AdmitFollowUp } from '@/node/admit-progress';
import { withKeyLogLock } from '@/node/enrollment-engine';
import { refreshMeshRelay } from '@/node/mesh-relay';
import type { RelayFlowDeps, RelayFlowMode } from '@/node/relay-enroll';
import { catchUpMetaKeyLagging, distributeMetaKey } from '@/node/relay-meta-key-admit';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
import type { RelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { defaultRelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { useMemo } from 'react';

export interface RelayAdmitFollowUpInput {
  /** 只在中继模式下做这件事。 */
  enabled: boolean;
  api: AuthApi;
  relayApi?: RelayTenantApi;
  mode: RelayFlowMode | null;
}

/**
 * 补发一条 `meta-key {op:'admit'}`，返回失败码（成功为 `null`）。
 *
 * node id 拿不到时（旧的重发路径没有证书对象）不放弃：改问服务端「现在谁还欠着」，
 * 按那份名单逐台补。
 */
async function deliverMetaKey(
  deps: RelayFlowDeps,
  nodeIdHex: string | null,
  signer: RecordSigner | null
): Promise<string | null> {
  if (!nodeIdHex) return (await catchUpMetaKeyLagging(deps, signer, deps.relayApi)).failedCode;
  const result = await distributeMetaKey(deps, nodeIdHex, signer);
  return result.ok ? null : result.code;
}

/** 无论成败都刷新一次中继状态，告警条据此上屏。 */
export function relayAdmitFollowUp(deps: RelayFlowDeps): AdmitFollowUp {
  return async (nodeIdHex, signer) => {
    const code = await deliverMetaKey(deps, nodeIdHex, signer);
    await refreshMeshRelay(deps.relayApi);
    return code === null ? { ok: true } : { ok: false, code };
  };
}

/**
 * 交给引擎的签名身份。中继状态还没拉到之前给 `null`（引擎把这个消费方当作不参与签名）：
 * 此时还不知道有没有第二步，照单步签下去会漏掉成员密钥却报「已加入」——
 * 「要不要紧跟一条 `meta-key`」不能吃没加载的快照（见 `mesh-relay.ts` 的 `fetchRelayMode`）。
 */
export function admitModeOnceRelayKnown<T>(
  relay: { loadedAt: number | null },
  mode: T | null
): T | null {
  return relay.loadedAt === null ? null : mode;
}

/** 交给 `useEnrollmentEngine` 的第二步；非中继模式或还没有主用户时为 `null`（加入只有一步）。 */
export function useRelayAdmitFollowUp(input: RelayAdmitFollowUpInput): AdmitFollowUp | null {
  const { api, enabled, mode } = input;
  const relayApi = input.relayApi ?? defaultRelayTenantApi;
  return useMemo(() => {
    if (!enabled || !mode) return null;
    return relayAdmitFollowUp({ api, relayApi, mode, lock: withKeyLogLock });
  }, [api, enabled, mode, relayApi]);
}
