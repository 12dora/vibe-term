// 中继模式下 admit 的收尾：把当前世代的 `K_meta` 封给刚加入的节点（`meta-key {op:'admit'}`）。
//
// 这一条落不下去，新节点解不开元数据块——读不到别人的状态、也封不出自己的状态块，名字与版本
// 永远上报不了，在各处只剩一串 node id。所以它**不能只是一条 toast**：
//   1. 先记欠账（`relay-meta-key-pending`），再尝试签；签成了才销账。
//   2. 没有可用签名者（复用窗口已过 / 一上来就是 passkey）时欠账照样留着，界面挂告警条。
//   3. 谁是欠账方以服务端为准：`GET /api/mesh/relay/status` 的 `metaKeyLagging` 按当前
//      `meta-key` 记录的封装条目算，换台机器、换标签页、刷新页面都看得到（见 relay-meta-lag.ts）。
//
// 从 `use-relay-admit-follow-up.ts` 拆出来：设置页、接入面板与「批准加入」按钮三条入口共用同一段。

import { leaseSigner, takeRememberedSigner } from '@/auth/credential-prompt';
import type { RecordSigner } from '@/auth/key-log-actions';
import type { RelayMetaKeyOp, RelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { defaultRelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { type RelayFlowDeps, type RelayFlowResult, appendMetaKey } from './relay-enroll';
import { forgetPendingMetaKey, rememberPendingMetaKey } from './relay-meta-key-pending';
import { refreshRelayPackForSigner } from './relay-pack';

/** 欠账条目的 id：按 node id 归一，同一台补几次只留一条。 */
export function metaKeyAdmitEntryId(nodeIdHex: string): string {
  return `admit:${nodeIdHex}`;
}

export const RELAY_META_KEY_NEEDS_SIGNER = 'RELAY_META_KEY_NEEDS_SIGNER';

/**
 * 给一台节点补发当前世代的 `K_meta`。
 *
 * **先落欠账再签**：签名途中断网 / 关标签页时欠账仍在，界面下次打开还看得见。
 * `signer` 不给就从 admit 刚用过的那把（5 分钟复用窗口）里现取——admit 与补发之间不该再问一次凭据。
 */
export async function distributeMetaKey(
  deps: RelayFlowDeps,
  nodeIdHex: string,
  signer?: RecordSigner | null
): Promise<RelayFlowResult> {
  const op: RelayMetaKeyOp = { op: 'admit', node_id: nodeIdHex };
  const entryId = metaKeyAdmitEntryId(nodeIdHex);
  rememberPendingMetaKey({ id: entryId, reason: 'admit', op });
  const useSigner = signer ?? takeRememberedSigner(Date.now());
  if (!useSigner) return { ok: false, code: RELAY_META_KEY_NEEDS_SIGNER };
  // 租约罩住整段：复用窗口到期的定时器不能在签名途中把根钥 seed 抹成 0。
  const release = leaseSigner(useSigner);
  try {
    const result = await appendMetaKey(deps, op, useSigner);
    // admit-node 与 meta-key 都是经 `prompt.request()` 的复用签名者落账的，`withSigner` 的
    // 钩子罩不到这条路：日志头已经往前走了，密封包必须在这里显式跟上。
    await refreshRelayPackForSigner(useSigner, { api: deps.api, relayApi: deps.relayApi });
    if (result.ok) {
      forgetPendingMetaKey(entryId);
      return result;
    }
    rememberPendingMetaKey({
      id: entryId,
      reason: 'admit',
      op,
      record: result.record ?? null,
    });
    return result;
  } finally {
    release();
  }
}

export type MetaKeyCatchUpSummary = {
  /** 这一轮认定还欠着的成员数（含本次没补成的）。 */
  lagging: number;
  /** 本次补发成功的成员数。 */
  delivered: number;
  /** 第一条失败的错误码；全成功为 `null`。 */
  failedCode: string | null;
};

/**
 * 按**服务端真相**把欠账补齐：拉一次 `/api/mesh/relay/status`，逐台补发。
 *
 * 密钥日志是一条链，必须串行；中途失败也继续往下走，剩下的欠账留在本地由重试回路接手。
 */
export async function catchUpMetaKeyLagging(
  deps: RelayFlowDeps,
  signer?: RecordSigner | null,
  relayApi: RelayTenantApi = defaultRelayTenantApi
): Promise<MetaKeyCatchUpSummary> {
  let rows: { nodeId: string }[];
  try {
    rows = (await relayApi.status()).metaKeyLagging;
  } catch {
    return { lagging: 0, delivered: 0, failedCode: null };
  }
  let delivered = 0;
  let failedCode: string | null = null;
  for (const row of rows) {
    const result = await distributeMetaKey(deps, row.nodeId, signer);
    if (result.ok) delivered += 1;
    else failedCode ??= result.code;
  }
  return { lagging: rows.length, delivered, failedCode };
}
