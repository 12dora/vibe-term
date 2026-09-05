import { describe, expect, test } from 'bun:test';
import {
  shareCountdownIntervalMs,
  shareRemaining,
  shareRemainingLabel,
  shareRemainingMs,
} from './share-format';

const NOW = 1_000_000;

describe('shareRemainingMs', () => {
  test('永久分享返回 null', () => {
    expect(shareRemainingMs(null, NOW)).toBeNull();
  });

  test('已过期收敛到 0', () => {
    expect(shareRemainingMs(NOW - 5_000, NOW)).toBe(0);
  });

  test('未过期返回剩余毫秒', () => {
    expect(shareRemainingMs(NOW + 5_000, NOW)).toBe(5_000);
  });
});

describe('shareRemaining', () => {
  test('超过一天按天 + 小时', () => {
    expect(shareRemaining(2 * 86_400_000 + 3 * 3_600_000)).toEqual({
      unit: 'days',
      primary: 2,
      secondary: 3,
    });
  });

  test('一小时到一天按小时 + 分', () => {
    expect(shareRemaining(3_600_000 + 90_000)).toEqual({
      unit: 'hours',
      primary: 1,
      secondary: 1,
    });
  });

  test('不足一小时按分 + 秒', () => {
    expect(shareRemaining(90_000)).toEqual({ unit: 'minutes', primary: 1, secondary: 30 });
    expect(shareRemaining(0)).toEqual({ unit: 'minutes', primary: 0, secondary: 0 });
  });

  test('负值按 0 处理', () => {
    expect(shareRemaining(-5)).toEqual({ unit: 'minutes', primary: 0, secondary: 0 });
  });
});

describe('shareRemainingLabel', () => {
  test('量级决定 i18n key 与插值', () => {
    expect(shareRemainingLabel(86_400_000)).toEqual({
      key: 'shareAccess.remainingDays',
      params: { days: 1, hours: 0 },
    });
    expect(shareRemainingLabel(7_200_000)).toEqual({
      key: 'shareAccess.remainingHours',
      params: { hours: 2, minutes: 0 },
    });
    expect(shareRemainingLabel(65_000)).toEqual({
      key: 'shareAccess.remainingMinutes',
      params: { minutes: 1, seconds: 5 },
    });
  });
});

describe('shareCountdownIntervalMs', () => {
  test('不足一小时每秒刷新，其余每分钟', () => {
    expect(shareCountdownIntervalMs(59_000)).toBe(1000);
    expect(shareCountdownIntervalMs(7_200_000)).toBe(60_000);
    expect(shareCountdownIntervalMs(null)).toBe(60_000);
  });
});
