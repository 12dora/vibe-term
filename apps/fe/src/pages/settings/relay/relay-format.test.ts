import { describe, expect, test } from 'bun:test';
import type { RelayQuota } from '@tmex/api-client/relay/admin-api';
import {
  bandwidthText,
  bytesToKb,
  epochText,
  kbToBytes,
  quotaSummary,
  relativeTimeText,
  shortTenantId,
  trafficText,
  uptimeText,
} from './relay-format';

// 文案不参与断言：`t` 直接回显 key 与参数，只测选了哪条 key、算出了什么数。
const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}(${JSON.stringify(options)})` : key;

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('shortTenantId', () => {
  test('32 位 hex 只留前 12 位并加省略号', () => {
    expect(shortTenantId('0123456789abcdef0123456789abcdef')).toBe('0123456789ab…');
  });

  test('不超过 12 位的原样返回', () => {
    expect(shortTenantId('0123456789ab')).toBe('0123456789ab');
    expect(shortTenantId('')).toBe('');
  });
});

describe('relativeTimeText', () => {
  test('null 是「从未」', () => {
    expect(relativeTimeText(t, null, NOW)).toBe('relay.admin.time.never');
  });

  test('一分钟内是「刚刚」，未来时间同样不出负数', () => {
    expect(relativeTimeText(t, NOW - 59_999, NOW)).toBe('relay.admin.time.justNow');
    expect(relativeTimeText(t, NOW + 5_000, NOW)).toBe('relay.admin.time.justNow');
  });

  test('分 / 时 / 天三档各自向下取整', () => {
    expect(relativeTimeText(t, NOW - 5 * MINUTE - 30_000, NOW)).toBe(
      'relay.admin.time.minutes({"n":5})'
    );
    expect(relativeTimeText(t, NOW - 3 * HOUR, NOW)).toBe('relay.admin.time.hours({"n":3})');
    expect(relativeTimeText(t, NOW - 10 * DAY, NOW)).toBe('relay.admin.time.days({"n":10})');
  });

  test('档位边界：整 60 分钟进小时档，整 24 小时进天档', () => {
    expect(relativeTimeText(t, NOW - HOUR, NOW)).toBe('relay.admin.time.hours({"n":1})');
    expect(relativeTimeText(t, NOW - DAY, NOW)).toBe('relay.admin.time.days({"n":1})');
  });
});

describe('uptimeText', () => {
  test('超过一天带小时', () => {
    expect(uptimeText(t, 2 * DAY + 3 * HOUR)).toBe('relay.admin.health.uptimeDays({"d":2,"h":3})');
  });

  test('不足一天带分钟', () => {
    expect(uptimeText(t, 5 * HOUR + 7 * MINUTE)).toBe(
      'relay.admin.health.uptimeHours({"h":5,"m":7})'
    );
  });

  test('不足一小时只有分钟；负数按 0 处理', () => {
    expect(uptimeText(t, 90_000)).toBe('relay.admin.health.uptimeMinutes({"m":1})');
    expect(uptimeText(t, -1)).toBe('relay.admin.health.uptimeMinutes({"m":0})');
  });
});

describe('bandwidthText', () => {
  test('null 是不限', () => {
    expect(bandwidthText(t, null)).toBe('relay.admin.quota.unlimitedValue');
  });

  test('按 KB/s 取整，非零的极小值不塌成 0', () => {
    expect(bandwidthText(t, 512 * 1024)).toBe('relay.admin.quota.bandwidthValue({"kb":512})');
    expect(bandwidthText(t, 100)).toBe('relay.admin.quota.bandwidthValue({"kb":1})');
  });

  test('KB 与字节互转', () => {
    expect(bytesToKb(1024)).toBe(1);
    expect(kbToBytes(64)).toBe(65_536);
  });
});

describe('quotaSummary', () => {
  const defaults: RelayQuota = { maxNodes: 8, maxStreams: 16, bandwidthBytesPerSec: 1024 };

  test('租户没有自己的配额时回落默认并打标', () => {
    const summary = quotaSummary(t, null, defaults);
    expect(summary.inherited).toBe(true);
    expect(summary.text).toContain('"nodes":8');
    expect(summary.text).toContain('"streams":16');
  });

  test('有覆盖就用覆盖值，不打标', () => {
    const summary = quotaSummary(
      t,
      { maxNodes: 2, maxStreams: 3, bandwidthBytesPerSec: null },
      defaults
    );
    expect(summary.inherited).toBe(false);
    expect(summary.text).toContain('"nodes":2');
    expect(summary.text).toContain('relay.admin.quota.unlimitedValue');
  });
});

describe('trafficText', () => {
  test('只出一个中转流量值', () => {
    expect(trafficText(2048)).toBe('2.00 KB');
  });
});

describe('epochText', () => {
  test('代次统一走「第 N 代」', () => {
    expect(epochText(t, 3)).toBe('relay.admin.epochValue({"epoch":3})');
  });
});
