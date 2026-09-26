import { describe, expect, test } from 'bun:test';
import {
  describeDevice,
  describeMethod,
  entryLabel,
  formatLoginTime,
  formatRetention,
  parseHistoryLimit,
  parsePolicyDuration,
  parseRetentionToken,
} from './auth-format';
import { UsageError } from './errors';

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

describe('login history formatting', () => {
  test('formats time, method, device, and background entry', () => {
    expect(formatLoginTime(1_700_000_000_000)).toBe('2023-11-14 22:13:20Z');
    expect(describeMethod('root', 'totp')).toBe('password+totp');
    expect(describeMethod('root', 'passkey')).toBe('password+passkey');
    expect(describeMethod('passkey', null)).toBe('passkey');
    expect(describeMethod('root', 'none')).toBe('password');
    expect(describeDevice(CHROME)).toBe('Chrome / macOS');
    expect(describeDevice(null)).toBe('-');
    expect(describeDevice('Edg/120.0')).toBe('Edge');
    const names = new Map([['aa', 'sh']]);
    expect(
      entryLabel(
        {
          at: 0,
          nodeName: 'jp',
          nodeId: 'bb',
          client: 'web',
          method: 'root',
          second: 'totp',
          ip: '1.2.3.4',
          userAgent: null,
          kind: 'background',
          viaNodeId: 'aa',
          code: null,
        },
        names
      )
    ).toBe('sh');
    expect(
      entryLabel(
        {
          at: 0,
          nodeName: 'jp',
          nodeId: 'bb',
          client: 'cli',
          method: 'root',
          second: null,
          ip: null,
          userAgent: null,
          kind: 'interactive',
          viaNodeId: 'aa',
          code: null,
        },
        names
      )
    ).toBe('-');
  });

  test('parses limit and retention', () => {
    expect(parseHistoryLimit(undefined)).toBe(200);
    expect(parseHistoryLimit(1)).toBe(1);
    expect(() => parseHistoryLimit(0)).toThrow(UsageError);
    expect(() => parseHistoryLimit(501)).toThrow(UsageError);
    expect(parseRetentionToken('90')).toBe(90);
    expect(parseRetentionToken('forever')).toBe(0);
    expect(formatRetention(0)).toBe('forever');
    expect(formatRetention(30)).toBe('30d');
    expect(() => parseRetentionToken('14')).toThrow(UsageError);
    expect(parsePolicyDuration('15m')).toBe(15 * 60_000);
    expect(parsePolicyDuration('24h')).toBe(24 * 3_600_000);
    expect(parsePolicyDuration('7d')).toBe(7 * 86_400_000);
  });
});
