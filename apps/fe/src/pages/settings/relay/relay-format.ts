// 中继运营面的展示格式化：全是纯函数，文案一律经 `t` 出。

import { formatBytes } from '@tmex/api-client/format';
import type { RelayQuota } from '@tmex/api-client/relay/admin-api';

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 租户编号是 16 字节 hex（32 字符），表里只摆前 12 位，完整值走复制按钮。 */
export const TENANT_ID_PREVIEW_LENGTH = 12;

export function shortTenantId(id: string): string {
  return id.length <= TENANT_ID_PREVIEW_LENGTH ? id : `${id.slice(0, TENANT_ID_PREVIEW_LENGTH)}…`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 相对时间。`null` 与未来时间都按「从未 / 刚刚」处理，不出现负数。 */
export function relativeTimeText(t: Translate, at: number | null, now: number): string {
  if (at === null) return t('relay.admin.time.never');
  const elapsed = now - at;
  if (elapsed < MINUTE_MS) return t('relay.admin.time.justNow');
  if (elapsed < HOUR_MS)
    return t('relay.admin.time.minutes', { n: Math.floor(elapsed / MINUTE_MS) });
  if (elapsed < DAY_MS) return t('relay.admin.time.hours', { n: Math.floor(elapsed / HOUR_MS) });
  return t('relay.admin.time.days', { n: Math.floor(elapsed / DAY_MS) });
}

/** 已运行时长：天 / 小时 / 分钟三档，最小档到分钟为止。 */
export function uptimeText(t: Translate, uptimeMs: number): string {
  const total = Math.max(0, Math.floor(uptimeMs));
  const days = Math.floor(total / DAY_MS);
  if (days > 0) {
    return t('relay.admin.health.uptimeDays', {
      d: days,
      h: Math.floor((total % DAY_MS) / HOUR_MS),
    });
  }
  const hours = Math.floor(total / HOUR_MS);
  if (hours > 0) {
    return t('relay.admin.health.uptimeHours', {
      h: hours,
      m: Math.floor((total % HOUR_MS) / MINUTE_MS),
    });
  }
  return t('relay.admin.health.uptimeMinutes', { m: Math.floor(total / MINUTE_MS) });
}

/** 带宽上限；`null` 即不限速。取整到 KB/s，非零的极小值不显示成 0。 */
export function bandwidthText(t: Translate, bytesPerSec: number | null): string {
  if (bytesPerSec === null) return t('relay.admin.quota.unlimitedValue');
  return t('relay.admin.quota.bandwidthValue', { kb: bytesToKb(bytesPerSec) });
}

export function bytesToKb(bytesPerSec: number): number {
  return Math.max(1, Math.round(bytesPerSec / 1024));
}

export function kbToBytes(kb: number): number {
  return kb * 1024;
}

export interface QuotaSummary {
  text: string;
  /** 该租户没有自己的配额，用的是默认值。 */
  inherited: boolean;
}

/** 租户的生效配额；`quota` 为 `null` 时回落默认并打标。 */
export function quotaSummary(
  t: Translate,
  quota: RelayQuota | null,
  defaultQuota: RelayQuota
): QuotaSummary {
  const effective = quota ?? defaultQuota;
  return {
    text: t('relay.admin.quota.summary', {
      nodes: effective.maxNodes,
      streams: effective.maxStreams,
      bandwidth: bandwidthText(t, effective.bandwidthBytesPerSec),
    }),
    inherited: quota === null,
  };
}

/**
 * 中转流量一格。中继每转发一帧都同时计进 `bytesIn` 与 `bytesOut`，
 * 两个计数逐字节相等，摆两列只会让人以为统计坏了——所以只出一个数。
 */
export function trafficText(bytes: number): string {
  return formatBytes(bytes);
}

/** 代次一格：口令 / 令牌 / 元数据密钥统一说「第 N 代」。 */
export function epochText(t: Translate, epoch: number): string {
  return t('relay.admin.epochValue', { epoch });
}
