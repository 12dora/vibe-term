// 剩余期限的展示换算：只出数值与量级，文案交给 i18n（`shareAccess.remaining*`）。

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type ShareRemainingUnit = 'days' | 'hours' | 'minutes';

export interface ShareRemaining {
  unit: ShareRemainingUnit;
  /** 大单位数值：天 / 小时 / 分 */
  primary: number;
  /** 小单位数值：小时 / 分 / 秒 */
  secondary: number;
}

/** 剩余毫秒；永久（expiresAt 为 null）返回 null，已过期返回 0。 */
export function shareRemainingMs(expiresAt: number | null, now: number): number | null {
  if (expiresAt === null) return null;
  return Math.max(0, expiresAt - now);
}

export function shareRemaining(ms: number): ShareRemaining {
  const safe = Math.max(0, ms);
  if (safe >= DAY_MS) {
    return {
      unit: 'days',
      primary: Math.floor(safe / DAY_MS),
      secondary: Math.floor((safe % DAY_MS) / HOUR_MS),
    };
  }
  if (safe >= HOUR_MS) {
    return {
      unit: 'hours',
      primary: Math.floor(safe / HOUR_MS),
      secondary: Math.floor((safe % HOUR_MS) / MINUTE_MS),
    };
  }
  return {
    unit: 'minutes',
    primary: Math.floor(safe / MINUTE_MS),
    secondary: Math.floor((safe % MINUTE_MS) / 1000),
  };
}

export interface ShareRemainingLabel {
  key: string;
  params: Record<string, number>;
}

/** 剩余量级 → i18n key 与插值参数。 */
export function shareRemainingLabel(ms: number): ShareRemainingLabel {
  const parts = shareRemaining(ms);
  if (parts.unit === 'days') {
    return {
      key: 'shareAccess.remainingDays',
      params: { days: parts.primary, hours: parts.secondary },
    };
  }
  if (parts.unit === 'hours') {
    return {
      key: 'shareAccess.remainingHours',
      params: { hours: parts.primary, minutes: parts.secondary },
    };
  }
  return {
    key: 'shareAccess.remainingMinutes',
    params: { minutes: parts.primary, seconds: parts.secondary },
  };
}

/** 倒计时刷新间隔：进入分钟级后每秒刷新，其余每分钟一次。 */
export function shareCountdownIntervalMs(remainingMs: number | null): number {
  if (remainingMs === null) return MINUTE_MS;
  return remainingMs < HOUR_MS ? 1000 : MINUTE_MS;
}
