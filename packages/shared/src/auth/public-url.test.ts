import { describe, expect, test } from 'bun:test';
import { canonicalPublicUrl } from './public-url';

describe('canonicalPublicUrl', () => {
  test('lowercases scheme and host, strips default ports and trailing slashes', () => {
    expect(canonicalPublicUrl('HTTPS://Hub.Example:443/')).toBe('https://hub.example');
    expect(canonicalPublicUrl('http://LOCALHOST:80/')).toBe('http://localhost');
    expect(canonicalPublicUrl('https://hub.example.com/')).toBe('https://hub.example.com');
    expect(canonicalPublicUrl('https://hub.example.com:443')).toBe('https://hub.example.com');
  });

  test('keeps non-root path without a trailing slash', () => {
    expect(canonicalPublicUrl('https://hub.example/vibeterm/')).toBe(
      'https://hub.example/vibeterm'
    );
    expect(canonicalPublicUrl('https://hub.example/a/b')).toBe('https://hub.example/a/b');
  });

  test('keeps non-default ports', () => {
    expect(canonicalPublicUrl('https://hub.example:8443/')).toBe('https://hub.example:8443');
    expect(canonicalPublicUrl('http://127.0.0.1:9883')).toBe('http://127.0.0.1:9883');
  });

  test('normalizes IPv6 hosts', () => {
    expect(canonicalPublicUrl('https://[::1]:443/')).toBe('https://[::1]');
    expect(canonicalPublicUrl('https://[2001:db8::1]:8443/path/')).toBe(
      'https://[2001:db8::1]:8443/path'
    );
  });

  test('is idempotent', () => {
    const canonical = canonicalPublicUrl('HTTPS://Hub.Example:443/foo/');
    expect(canonicalPublicUrl(canonical)).toBe(canonical);
  });

  test('rejects credentials, query, and fragment', () => {
    expect(() => canonicalPublicUrl('https://user:pass@hub.example')).toThrow(/credentials/);
    expect(() => canonicalPublicUrl('https://user@hub.example')).toThrow(/credentials/);
    expect(() => canonicalPublicUrl('https://hub.example?x=1')).toThrow(/query|fragment/);
    expect(() => canonicalPublicUrl('https://hub.example#frag')).toThrow(/query|fragment/);
  });

  test('rejects invalid URLs', () => {
    expect(() => canonicalPublicUrl('not-a-url')).toThrow(/invalid public url/);
    expect(() => canonicalPublicUrl('ftp://hub.example')).toThrow(/invalid public url/);
    expect(() => canonicalPublicUrl('https://')).toThrow(/invalid public url/);
  });
});
