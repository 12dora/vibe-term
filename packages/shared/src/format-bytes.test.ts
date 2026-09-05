import { describe, expect, test } from 'bun:test';
import { formatBytes, formatBytesPair, formatRate } from './format-bytes';

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

describe('formatRate', () => {
  test('补 /s，且不把浮点原样摆出来', () => {
    expect(formatRate(237.51937984496124)).toBe('237.52 B/s');
    expect(formatRate(512)).toBe('512 B/s');
    expect(formatRate(2048)).toBe('2.00 KB/s');
    expect(formatRate(-1)).toBe('0 B/s');
    expect(formatRate(Number.NaN)).toBe('0 B/s');
  });
});

describe('formatBytesPair', () => {
  test('已传与总量共用同一套分档', () => {
    expect(formatBytesPair(0, 2048)).toBe('0 B / 2.00 KB');
    expect(formatBytesPair(1024, 2048)).toBe('1.00 KB / 2.00 KB');
  });
});
