import { describe, expect, test } from 'bun:test';
import {
  formatBytes,
  formatBytesFixed,
  formatBytesPair,
  formatEta,
  formatRate,
  formatRateParts,
} from './format-bytes';

describe('formatBytes', () => {
  test('按量级换算，KB 以上按大小定小数位', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.00 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20.0 MB');
    expect(formatBytes(200 * 1024 * 1024)).toBe('200 MB');
    expect(formatBytes(1024 ** 4 * 3)).toBe('3.00 TB');
  });

  test('1 KB 以下最多两位小数', () => {
    expect(formatBytes(512.3456)).toBe('512.35 B');
    expect(formatBytes(12.345678)).toBe('12.35 B');
    expect(formatBytes(0.004)).toBe('0 B');
    expect(formatBytes(0.006)).toBe('0.01 B');
    expect(formatBytes(12.1)).toBe('12.1 B');
    // 收完两位后已经够 1 KB，就该进上一档
    expect(formatBytes(1023.999)).toBe('1.00 KB');
  });

  test('负数与非有限值按 0 计', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});

describe('formatBytesFixed', () => {
  test('从 KB 起档，固定一位小数', () => {
    expect(formatBytesFixed(0)).toBe('0.0 KB');
    expect(formatBytesFixed(512)).toBe('0.5 KB');
    expect(formatBytesFixed(2048)).toBe('2.0 KB');
    expect(formatBytesFixed(20 * 1024 * 1024)).toBe('20.0 MB');
    expect(formatBytesFixed(200 * 1024 * 1024)).toBe('200.0 MB');
    expect(formatBytesFixed(1024 ** 4 * 3)).toBe('3.0 TB');
  });

  test('一位小数收完够进位就进上一档，不摆 1024.0 KB', () => {
    expect(formatBytesFixed(1024 * 1024 - 10)).toBe('1.0 MB');
  });

  test('负数与非有限值按 0 计', () => {
    expect(formatBytesFixed(-1)).toBe('0.0 KB');
    expect(formatBytesFixed(Number.NaN)).toBe('0.0 KB');
    expect(formatBytesFixed(Number.POSITIVE_INFINITY)).toBe('0.0 KB');
  });
});

describe('formatRate', () => {
  test('固定一位小数、固定两字符单位，列宽不随数值抖', () => {
    expect(formatRate(237.51937984496124)).toBe('0.2 KB/s');
    expect(formatRate(512)).toBe('0.5 KB/s');
    expect(formatRate(2048)).toBe('2.0 KB/s');
    expect(formatRate(16 * 1024)).toBe('16.0 KB/s');
    expect(formatRate(12.3 * 1024 * 1024)).toBe('12.3 MB/s');
  });

  test('最低一档是 0.0 KB/s，永远不出现单字符的 B/s', () => {
    expect(formatRate(0)).toBe('0.0 KB/s');
    expect(formatRate(-1)).toBe('0.0 KB/s');
    expect(formatRate(Number.NaN)).toBe('0.0 KB/s');
    expect(formatRate(1)).toBe('0.0 KB/s');
  });

  test('跨量级切换时小数位与单位长度都不变', () => {
    const samples = [0, 1, 1023, 1024, 1024 ** 2 - 1, 1024 ** 2, 1024 ** 3, 1024 ** 4];
    for (const bytes of samples) {
      const text = formatRate(bytes);
      expect(text).toMatch(/^\d+\.\d [KMGT]B\/s$/);
    }
  });
});

describe('formatRateParts', () => {
  test('拆出数字与单位，text 就是两者拼起来', () => {
    expect(formatRateParts(12.3 * 1024 * 1024)).toEqual({
      text: '12.3 MB/s',
      value: '12.3',
      unit: 'MB',
    });
    expect(formatRateParts(0)).toEqual({ text: '0.0 KB/s', value: '0.0', unit: 'KB' });
    expect(formatRateParts(1024 ** 4)).toEqual({ text: '1.0 TB/s', value: '1.0', unit: 'TB' });
  });

  test('单位一律两字符', () => {
    for (const bytes of [0, 1, 1024, 1024 ** 2, 1024 ** 3, 1024 ** 4, 1024 ** 5]) {
      expect(formatRateParts(bytes).unit.length).toBe(2);
    }
  });
});

describe('formatBytesPair', () => {
  test('已传与总量共用同一套分档，且位数固定', () => {
    expect(formatBytesPair(0, 2048)).toBe('0.0 KB / 2.0 KB');
    expect(formatBytesPair(1024, 2048)).toBe('1.0 KB / 2.0 KB');
    expect(formatBytesPair(1024 * 1024, 20 * 1024 * 1024)).toBe('1.0 MB / 20.0 MB');
  });
});

describe('formatEta', () => {
  test('无法估算时给短横线', () => {
    expect(formatEta(null)).toBe('--');
    expect(formatEta(undefined)).toBe('--');
    expect(formatEta(Number.NaN)).toBe('--');
    expect(formatEta(Number.POSITIVE_INFINITY)).toBe('--');
    expect(formatEta(-1)).toBe('--');
  });

  test('不足一小时为 m:ss', () => {
    expect(formatEta(0)).toBe('0:00');
    expect(formatEta(9)).toBe('0:09');
    expect(formatEta(65.4)).toBe('1:05');
    expect(formatEta(3599)).toBe('59:59');
  });

  test('超过一小时为 h:mm:ss，并在 99:59:59 封顶', () => {
    expect(formatEta(3600)).toBe('1:00:00');
    expect(formatEta(3661)).toBe('1:01:01');
    expect(formatEta(1e9)).toBe('99:59:59');
  });
});
