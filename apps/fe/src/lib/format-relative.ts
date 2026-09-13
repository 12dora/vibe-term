// 相对时间与紧凑时长：节点表 / 中继运营 / 分享历史共用同一套分档。
// i18n 前缀由调用方传入；`settings.share.time` 的分/时/天 key 带 Ago 后缀。

export type Translate = (key: string, options?: Record<string, unknown>) => string;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SECOND_MS = 1_000;

/**
 * 相对过去时间。`at` 缺失或非有限返回 `null`（「从未」由调用方自己出）。
 * 未来时间按 0 流逝处理，不出现负数。
 */
export function formatRelative(
  t: Translate,
  at: number | null | undefined,
  now: number,
  keyPrefix: string
): string | null {
  if (at == null || !Number.isFinite(at)) return null;
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE_MS) return t(`${keyPrefix}.justNow`);
  if (elapsed < HOUR_MS) {
    return t(unitKey(keyPrefix, 'minutes'), { n: Math.floor(elapsed / MINUTE_MS) });
  }
  if (elapsed < DAY_MS) {
    return t(unitKey(keyPrefix, 'hours'), { n: Math.floor(elapsed / HOUR_MS) });
  }
  return t(unitKey(keyPrefix, 'days'), { n: Math.floor(elapsed / DAY_MS) });
}

function unitKey(prefix: string, unit: 'minutes' | 'hours' | 'days'): string {
  return prefix === 'settings.share.time' ? `${prefix}.${unit}Ago` : `${prefix}.${unit}`;
}

/** 紧凑时长：只出两级，最小到秒。非法 / 非正数出 `0s`。 */
export function formatCompactDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const total = Math.floor(ms / SECOND_MS);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
