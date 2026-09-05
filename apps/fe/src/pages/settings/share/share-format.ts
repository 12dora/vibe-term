// 「分享」标签的展示格式化：全是纯函数，文案一律经 `t` 出。

import { formatBytes } from '@tmex/api-client/format';
import type { ShareEndReason, ShareRecord } from '@tmex/shared/share';

export type Translate = (key: string, options?: Record<string, unknown>) => string;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 终端列：有设备名就「设备 · 窗口」，拿不到设备名（已删除）只出窗口名。 */
export function shareTerminalText(record: ShareRecord, deviceName: string | null): string {
  return deviceName ? `${deviceName} · ${record.windowName}` : record.windowName;
}

/** 相对过去时间：刚刚 / N 分钟前 / N 小时前 / N 天前。 */
export function relativePastText(t: Translate, at: number, now: number): string {
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE_MS) return t('settings.share.time.justNow');
  if (elapsed < HOUR_MS)
    return t('settings.share.time.minutesAgo', { n: Math.floor(elapsed / MINUTE_MS) });
  if (elapsed < DAY_MS)
    return t('settings.share.time.hoursAgo', { n: Math.floor(elapsed / HOUR_MS) });
  return t('settings.share.time.daysAgo', { n: Math.floor(elapsed / DAY_MS) });
}

/** 到期列：永久 / 已到期 / 剩余 N 分钟（小时、天）。 */
export function expiresText(t: Translate, expiresAt: number | null, now: number): string {
  if (expiresAt === null) return t('settings.share.permanent');
  const left = expiresAt - now;
  if (left <= 0) return t('settings.share.expired');
  if (left < HOUR_MS)
    return t('settings.share.time.minutesLeft', { n: Math.max(1, Math.floor(left / MINUTE_MS)) });
  if (left < DAY_MS) return t('settings.share.time.hoursLeft', { n: Math.floor(left / HOUR_MS) });
  return t('settings.share.time.daysLeft', { n: Math.floor(left / DAY_MS) });
}

/** 绝对时间，给相对时间当 tooltip；`null` 出空串。 */
export function absoluteTimeText(at: number | null): string {
  if (at === null) return '';
  return new Date(at).toLocaleString();
}

const END_REASON_KEY: Record<ShareEndReason, string> = {
  revoked: 'settings.share.history.reason.revoked',
  expired: 'settings.share.history.reason.expired',
  window_closed: 'settings.share.history.reason.windowClosed',
  device_removed: 'settings.share.history.reason.deviceRemoved',
};

export function endReasonText(t: Translate, reason: ShareEndReason | null): string {
  return reason === null ? t('settings.share.history.reason.ended') : t(END_REASON_KEY[reason]);
}

/** 分享持续时长：两级（天时 / 时分 / 分秒），未结束的按当前时刻算。 */
export function durationText(record: ShareRecord, now: number): string {
  const total = Math.max(0, (record.endedAt ?? now) - record.createdAt);
  const days = Math.floor(total / DAY_MS);
  const hours = Math.floor((total % DAY_MS) / HOUR_MS);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((total % HOUR_MS) / MINUTE_MS);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${Math.floor((total % MINUTE_MS) / 1000)}s`;
}

/** 日志列：没有日志出「无日志」，被截断的额外标一笔。 */
export function logSizeText(t: Translate, record: ShareRecord): string {
  if (record.logBytes <= 0) return t('settings.share.history.noLog');
  const size = formatBytes(record.logBytes);
  return record.logTruncated ? t('settings.share.history.logTruncated', { size }) : size;
}

/** 链接地址列只出主机名：完整链接走复制按钮。 */
export function originHostText(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
