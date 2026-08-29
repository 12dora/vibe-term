import { describe, expect, test } from 'bun:test';
import { canonicalHubUrl } from './hub-url';

describe('canonicalHubUrl', () => {
  test('lowercases scheme and host, strips default ports and trailing slashes', () => {
    expect(canonicalHubUrl('HTTPS://Hub.Example:443/')).toBe('https://hub.example');
    expect(canonicalHubUrl('http://LOCALHOST:80/')).toBe('http://localhost');
    expect(canonicalHubUrl('https://hub.example.com/')).toBe('https://hub.example.com');
    expect(canonicalHubUrl('https://hub.example.com:443')).toBe('https://hub.example.com');
  });

  test('keeps non-root path without a trailing slash', () => {
    expect(canonicalHubUrl('https://hub.example/tmex/')).toBe('https://hub.example/tmex');
    expect(canonicalHubUrl('https://hub.example/a/b')).toBe('https://hub.example/a/b');
  });

  test('keeps non-default ports', () => {
    expect(canonicalHubUrl('https://hub.example:8443/')).toBe('https://hub.example:8443');
    expect(canonicalHubUrl('http://127.0.0.1:9883')).toBe('http://127.0.0.1:9883');
  });

  test('normalizes IPv6 hosts', () => {
    expect(canonicalHubUrl('https://[::1]:443/')).toBe('https://[::1]');
    expect(canonicalHubUrl('https://[2001:db8::1]:8443/path/')).toBe(
      'https://[2001:db8::1]:8443/path'
    );
  });

  test('is idempotent', () => {
    const canonical = canonicalHubUrl('HTTPS://Hub.Example:443/foo/');
    expect(canonicalHubUrl(canonical)).toBe(canonical);
  });

  test('rejects credentials, query, and fragment', () => {
    expect(() => canonicalHubUrl('https://user:pass@hub.example')).toThrow(/credentials/);
    expect(() => canonicalHubUrl('https://user@hub.example')).toThrow(/credentials/);
    expect(() => canonicalHubUrl('https://hub.example?x=1')).toThrow(/query|fragment/);
    expect(() => canonicalHubUrl('https://hub.example#frag')).toThrow(/query|fragment/);
  });

  test('rejects invalid URLs', () => {
    expect(() => canonicalHubUrl('not-a-url')).toThrow(/invalid hub url/);
    expect(() => canonicalHubUrl('ftp://hub.example')).toThrow(/invalid hub url/);
    expect(() => canonicalHubUrl('https://')).toThrow(/invalid hub url/);
  });
});
