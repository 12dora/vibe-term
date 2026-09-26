import { describe, expect, test } from 'bun:test';
import { sameSiteNextPath } from './login-next';

describe('sameSiteNextPath', () => {
  test('keeps same-site paths with query and hash', () => {
    expect(sameSiteNextPath('/')).toBe('/');
    expect(sameSiteNextPath('/settings?tab=nodes#top')).toBe('/settings?tab=nodes#top');
    expect(sameSiteNextPath('/n/0123456789abcdef0123456789abcdef/devices')).toBe(
      '/n/0123456789abcdef0123456789abcdef/devices'
    );
  });

  test('falls back to / when missing', () => {
    expect(sameSiteNextPath(null)).toBe('/');
    expect(sameSiteNextPath(undefined)).toBe('/');
    expect(sameSiteNextPath('')).toBe('/');
  });

  test('rejects protocol-relative, backslash and absolute URLs', () => {
    for (const raw of [
      '//evil.com',
      '///evil.com',
      '/\\evil.com',
      '\\\\evil.com',
      '/foo\\bar',
      'https://evil.com',
      'javascript:alert(1)',
      'evil.com/path',
      'settings',
    ]) {
      expect(sameSiteNextPath(raw)).toBe('/');
    }
  });

  test('rejects control characters browsers would strip', () => {
    expect(sameSiteNextPath('/\t/evil.com')).toBe('/');
    expect(sameSiteNextPath('/\n/evil.com')).toBe('/');
    expect(sameSiteNextPath('/\r/evil.com')).toBe('/');
    expect(sameSiteNextPath('/ok\u0000')).toBe('/');
  });
});
