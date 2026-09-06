// 文件传输的生效大小上限：本机配置与中继下发的「单文件上限」取小。
//
// 中继看不到流里传的是什么（peer 会话整段是 AES-GCM 密文），单文件上限只能由中继发布、
// 租户节点执行；真正保护运营者的是中继级带宽闸。这里是节点侧唯一的执行点。

import type { RelayQuota } from '@vibeterm/shared/relay';

type RelayQuotaLike = { maxFileBytes?: number | null } | null | undefined;

let provider: (() => RelayQuota | null) | null = null;

/** 由 mesh 中继接线注入；未接入中继时不注册，或返回 `null`。 */
export function setRelayQuotaProvider(next: (() => RelayQuota | null) | null): void {
  provider = next;
}

export function currentRelayQuota(): RelayQuota | null {
  try {
    return provider?.() ?? null;
  } catch {
    return null;
  }
}

/** 两个上限取小；中继未下发（`null`/缺失）时只看本机配置。 */
export function effectiveTransferMaxBytes(configMax: number, relayQuota: RelayQuotaLike): number {
  const relayMax = relayQuota?.maxFileBytes;
  if (typeof relayMax !== 'number' || relayMax < 0) return configMax;
  return Math.min(configMax, relayMax);
}

/** 调用点的便捷版：直接读当前中继配额。 */
export function transferMaxBytesNow(configMax: number): number {
  return effectiveTransferMaxBytes(configMax, currentRelayQuota());
}
