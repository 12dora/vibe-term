// 中继下发的三档配额：节点、并发流、带宽。
//
// 拆成纯函数是因为「有没有实时用量」这件事要分四种情形：旧中继不下发 `usage`（只剩上限）、
// 带宽可以无上限、`currentNodes` 与 `usage.currentNodes` 两处都可能给、带宽用量的字段名
// 还在演进。摊在 JSX 里必然写成一串三元。

import { formatRate } from '@tmex/api-client/format';
import type { RelayQuotaView } from '@tmex/api-client/relay/tenant-api';

export type RelayQuotaKind = 'nodes' | 'streams' | 'bandwidth';

export interface RelayQuotaRow {
  kind: RelayQuotaKind;
  labelKey: string;
  testId: string;
  /** 已用；中继不下发用量时为 `null`（此时只显示上限）。 */
  usedText: string | null;
  /** 上限；无上限时是「不限」的 i18n key。 */
  limitText: string | null;
  limitKey: string | null;
  /** 进度条百分比；无上限或用量未知时为 `null`。 */
  percent: number | null;
}

/** 带宽用量：网关补上 `bandwidthBytesPerSec` 时以它为准，否则取收发里大的那一头。 */
function bandwidthUsed(usage: RelayQuotaView['usage']): number | null {
  if (!usage) return null;
  const combined = (usage as { bandwidthBytesPerSec?: number }).bandwidthBytesPerSec;
  if (typeof combined === 'number') return combined;
  return Math.max(usage.bytesInPerSec, usage.bytesOutPerSec);
}

function percentOf(used: number | null, limit: number): number | null {
  if (used === null || limit <= 0) return null;
  return Math.min(100, (used / limit) * 100);
}

export function relayQuotaRows(quota: RelayQuotaView): RelayQuotaRow[] {
  const usage = quota.usage ?? null;
  const nodesUsed = usage?.currentNodes ?? quota.currentNodes ?? null;
  const streamsUsed = usage?.currentStreams ?? null;
  const bandwidth = bandwidthUsed(usage);
  const limit = quota.bandwidthBytesPerSec;
  const unlimited = limit === null || limit <= 0;
  return [
    {
      kind: 'nodes',
      labelKey: 'nodes.machine.details.quotaNodes',
      testId: 'nodes-relay-quota',
      usedText: nodesUsed === null ? null : String(nodesUsed),
      limitText: String(quota.maxNodes),
      limitKey: null,
      percent: percentOf(nodesUsed, quota.maxNodes),
    },
    {
      kind: 'streams',
      labelKey: 'nodes.machine.details.quotaStreams',
      testId: 'nodes-relay-streams',
      usedText: streamsUsed === null ? null : String(streamsUsed),
      limitText: String(quota.maxStreams),
      limitKey: null,
      percent: percentOf(streamsUsed, quota.maxStreams),
    },
    {
      kind: 'bandwidth',
      labelKey: 'nodes.machine.details.quotaBandwidth',
      testId: 'nodes-relay-bandwidth',
      usedText: bandwidth === null ? null : formatRate(bandwidth),
      limitText: unlimited ? null : formatRate(limit),
      limitKey: unlimited ? 'nodes.machine.details.quotaUnlimited' : null,
      percent: unlimited ? null : percentOf(bandwidth, limit),
    },
  ];
}
