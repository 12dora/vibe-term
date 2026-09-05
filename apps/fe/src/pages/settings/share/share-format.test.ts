// 表格展示的格式化：相对时间、剩余期限、结束原因、时长、日志大小、地址主机名。

import { describe, expect, test } from 'bun:test';
import type { ShareRecord } from '@tmex/shared/share';
import {
  absoluteTimeText,
  durationText,
  endReasonText,
  expiresText,
  logSizeText,
  originHostText,
  relativePastText,
  shareTerminalText,
} from './share-format';

/** 文案只看 key 与参数，翻译交给 i18next。 */
const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key;

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function record(partial: Partial<ShareRecord> = {}): ShareRecord {
  return {
    id: 'abc',
    name: 'demo',
    deviceId: 'dev1',
    windowId: '@1',
    windowName: 'build',
    state: 'ended',
    endReason: 'revoked',
    createdAt: NOW - HOUR,
    expiresAt: null,
    endedAt: NOW,
    origin: 'https://tmex.example.com',
    url: 'https://tmex.example.com/s/abc',
    viewers: 0,
    logBytes: 0,
    logTruncated: false,
    recordLog: true,
    ...partial,
  };
}

describe('shareTerminalText', () => {
  test('有设备名就「设备 · 窗口」', () => {
    expect(shareTerminalText(record(), 'MacBook')).toBe('MacBook · build');
  });

  test('设备已删除只出窗口名', () => {
    expect(shareTerminalText(record(), null)).toBe('build');
  });
});

describe('relativePastText', () => {
  test('一分钟内是「刚刚」，之后按分/时/天进档', () => {
    expect(relativePastText(t, NOW - 5_000, NOW)).toBe('settings.share.time.justNow');
    expect(relativePastText(t, NOW - 3 * MINUTE, NOW)).toBe(
      'settings.share.time.minutesAgo:{"n":3}'
    );
    expect(relativePastText(t, NOW - 5 * HOUR, NOW)).toBe('settings.share.time.hoursAgo:{"n":5}');
    expect(relativePastText(t, NOW - 9 * DAY, NOW)).toBe('settings.share.time.daysAgo:{"n":9}');
  });

  test('时间戳在未来不出负数', () => {
    expect(relativePastText(t, NOW + HOUR, NOW)).toBe('settings.share.time.justNow');
  });
});

describe('expiresText', () => {
  test('永久分享不算剩余', () => {
    expect(expiresText(t, null, NOW)).toBe('settings.share.permanent');
  });

  test('已过期直接说已到期', () => {
    expect(expiresText(t, NOW - 1, NOW)).toBe('settings.share.expired');
  });

  test('按分/时/天进档，不足一分钟按一分钟', () => {
    expect(expiresText(t, NOW + 20_000, NOW)).toBe('settings.share.time.minutesLeft:{"n":1}');
    expect(expiresText(t, NOW + 30 * MINUTE, NOW)).toBe('settings.share.time.minutesLeft:{"n":30}');
    expect(expiresText(t, NOW + 5 * HOUR, NOW)).toBe('settings.share.time.hoursLeft:{"n":5}');
    expect(expiresText(t, NOW + 3 * DAY, NOW)).toBe('settings.share.time.daysLeft:{"n":3}');
  });
});

describe('endReasonText', () => {
  test('四种结束原因各有短标签', () => {
    expect(endReasonText(t, 'revoked')).toBe('settings.share.history.reason.revoked');
    expect(endReasonText(t, 'expired')).toBe('settings.share.history.reason.expired');
    expect(endReasonText(t, 'window_closed')).toBe('settings.share.history.reason.windowClosed');
    expect(endReasonText(t, 'device_removed')).toBe('settings.share.history.reason.deviceRemoved');
  });

  test('原因缺失时退回通用「已结束」', () => {
    expect(endReasonText(t, null)).toBe('settings.share.history.reason.ended');
  });
});

describe('durationText', () => {
  test('两级展示，最小到秒', () => {
    expect(durationText(record({ createdAt: NOW - 90_000, endedAt: NOW }), NOW)).toBe('1m 30s');
    expect(
      durationText(record({ createdAt: NOW - (2 * HOUR + 5 * MINUTE), endedAt: NOW }), NOW)
    ).toBe('2h 5m');
    expect(durationText(record({ createdAt: NOW - (3 * DAY + HOUR), endedAt: NOW }), NOW)).toBe(
      '3d 1h'
    );
  });

  test('未结束的按当前时刻算', () => {
    expect(durationText(record({ createdAt: NOW - 60_000, endedAt: null }), NOW)).toBe('1m 0s');
  });
});

describe('logSizeText', () => {
  test('没有日志给专门的说法', () => {
    expect(logSizeText(t, record({ logBytes: 0 }))).toBe('settings.share.history.noLog');
  });

  test('有日志出人读的大小，截断的另标一笔', () => {
    expect(logSizeText(t, record({ logBytes: 2048 }))).toContain('2');
    expect(logSizeText(t, record({ logBytes: 2048, logTruncated: true }))).toContain(
      'settings.share.history.logTruncated'
    );
  });
});

describe('originHostText', () => {
  test('只出主机名', () => {
    expect(originHostText('https://tmex.example.com')).toBe('tmex.example.com');
    expect(originHostText('https://tmex.example.com:8443')).toBe('tmex.example.com:8443');
  });

  test('拿不到合法 URL 时原样展示', () => {
    expect(originHostText('not a url')).toBe('not a url');
  });
});

describe('absoluteTimeText', () => {
  test('空时间出空串（tooltip 不显示）', () => {
    expect(absoluteTimeText(null)).toBe('');
    expect(absoluteTimeText(NOW).length).toBeGreaterThan(0);
  });
});
