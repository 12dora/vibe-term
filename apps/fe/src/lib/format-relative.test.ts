import { describe, expect, test } from 'bun:test';
import { formatCompactDuration, formatRelative } from './format-relative';

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key;

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatRelative', () => {
  test('按前缀拼 justNow / minutes / hours / days', () => {
    expect(formatRelative(t, NOW - 1_000, NOW, 'nodes.time')).toBe('nodes.time.justNow');
    expect(formatRelative(t, NOW - 5 * MINUTE, NOW, 'nodes.time')).toBe(
      'nodes.time.minutes:{"n":5}'
    );
    expect(formatRelative(t, NOW - 3 * HOUR, NOW, 'relay.admin.time')).toBe(
      'relay.admin.time.hours:{"n":3}'
    );
    expect(formatRelative(t, NOW - 2 * DAY, NOW, 'relay.admin.time')).toBe(
      'relay.admin.time.days:{"n":2}'
    );
  });

  test('分享前缀的分/时/天带 Ago 后缀', () => {
    expect(formatRelative(t, NOW - 3 * MINUTE, NOW, 'settings.share.time')).toBe(
      'settings.share.time.minutesAgo:{"n":3}'
    );
    expect(formatRelative(t, NOW - 5 * HOUR, NOW, 'settings.share.time')).toBe(
      'settings.share.time.hoursAgo:{"n":5}'
    );
    expect(formatRelative(t, NOW - 9 * DAY, NOW, 'settings.share.time')).toBe(
      'settings.share.time.daysAgo:{"n":9}'
    );
  });

  test('缺失与非有限返回 null；未来时间按刚刚', () => {
    expect(formatRelative(t, null, NOW, 'nodes.time')).toBeNull();
    expect(formatRelative(t, Number.NaN, NOW, 'nodes.time')).toBeNull();
    expect(formatRelative(t, NOW + HOUR, NOW, 'nodes.time')).toBe('nodes.time.justNow');
  });

  test('档位边界：整 60 分钟进小时，整 24 小时进天', () => {
    expect(formatRelative(t, NOW - HOUR, NOW, 'relay.admin.time')).toBe(
      'relay.admin.time.hours:{"n":1}'
    );
    expect(formatRelative(t, NOW - DAY, NOW, 'relay.admin.time')).toBe(
      'relay.admin.time.days:{"n":1}'
    );
  });
});

describe('formatCompactDuration', () => {
  test('只出两级，最小到秒', () => {
    expect(formatCompactDuration(45_000)).toBe('45s');
    expect(formatCompactDuration(90_000)).toBe('1m 30s');
    expect(formatCompactDuration(3 * HOUR + 12 * MINUTE)).toBe('3h 12m');
    expect(formatCompactDuration(4 * DAY + 6 * HOUR)).toBe('4d 6h');
  });

  test('零与非法值不出负数', () => {
    expect(formatCompactDuration(0)).toBe('0s');
    expect(formatCompactDuration(-1)).toBe('0s');
    expect(formatCompactDuration(Number.NaN)).toBe('0s');
  });
});
