// 中继运营面的展示格式化：全是纯函数，文案一律经 `t` 出。

import { formatCompactDuration, formatRelative } from '@/lib/format-relative';
import { formatBytesFixed } from '@vibeterm/api-client/format';
import type { RelayQuota } from '@vibeterm/api-client/relay/admin-api';

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
  return formatRelative(t, at, now, 'relay.admin.time') ?? t('relay.admin.time.justNow');
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

const MB = 1024 * 1024;

export function bytesToMb(bytes: number): number {
  return Math.max(1, Math.round(bytes / MB));
}

export function mbToBytes(mb: number): number {
  return mb * MB;
}

/** 单文件上限；`null` / 缺失即不限。 */
export function maxFileText(t: Translate, bytes: number | null | undefined): string {
  if (bytes == null) return t('relay.admin.quota.unlimitedValue');
  return t('relay.admin.quota.maxFileValue', { mb: bytesToMb(bytes) });
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
      maxFile: maxFileText(t, effective.maxFileBytes),
    }),
    inherited: quota === null,
  };
}

/**
 * 中转流量一格。中继每转发一帧都同时计进 `bytesIn` 与 `bytesOut`，
 * 两个计数逐字节相等，摆两列只会让人以为统计坏了——所以只出一个数。
 */
export function trafficText(bytes: number): string {
  return formatBytesFixed(bytes);
}

/** 代次一格：口令 / 令牌 / 元数据密钥统一说「第 N 代」。 */
export function epochText(t: Translate, epoch: number): string {
  return t('relay.admin.epochValue', { epoch });
}

// ---------------------------------------------------------------------------
// 运行指标（`GET /api/relay/metrics`）的展示格式化
// ---------------------------------------------------------------------------

/** 帧率。四位数以上收成 k，避免磁贴里的大数把标签挤掉。 */
export function formatFramesPerSec(framesPerSec: number): string {
  const value = Number.isFinite(framesPerSec) && framesPerSec > 0 ? framesPerSec : 0;
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value >= 100) return String(Math.round(value));
  return value.toFixed(1);
}

/** 紧凑时长：只出两级，最小到秒。用于磁贴里的「运行时长」。 */
export function formatDuration(ms: number): string {
  return formatCompactDuration(ms);
}

/** 毫秒量。`null` 出破折号；秒级以上换算成秒，免得摆出五位数。 */
export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const value = Math.max(0, ms);
  if (value >= 10_000) return `${(value / 1000).toFixed(0)} s`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)} s`;
  if (value >= 100) return `${Math.round(value)} ms`;
  return `${value.toFixed(1)} ms`;
}

/** 百分比。`null` 出破折号（采样窗口不足时 CPU 占用拿不到）。 */
export function formatPercent(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  const value = Math.min(100, Math.max(0, pct));
  return value >= 10 ? `${Math.round(value)}%` : `${value.toFixed(1)}%`;
}

/** 中位数。空集合或全为 `null` 时回 `null`。 */
export function median(values: readonly (number | null)[]): number | null {
  const finite = values
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 === 1 ? finite[mid] : (finite[mid - 1] + finite[mid]) / 2;
}
