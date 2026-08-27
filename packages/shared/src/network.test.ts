import { describe, expect, test } from 'bun:test';
import { formatHttpEndpoint, rewriteWildcardBindHost } from './network';

describe('formatHttpEndpoint', () => {
  test('formats IPv4 host and port', () => {
    expect(formatHttpEndpoint('127.0.0.1', 9883)).toBe('http://127.0.0.1:9883');
    expect(formatHttpEndpoint('127.0.0.1', '9883', '/healthz')).toBe(
      'http://127.0.0.1:9883/healthz'
    );
  });

  test('wraps IPv6 hosts in brackets', () => {
    expect(formatHttpEndpoint('::1', 9883)).toBe('http://[::1]:9883');
    expect(formatHttpEndpoint('2001:db8::1', 9883, '/healthz')).toBe(
      'http://[2001:db8::1]:9883/healthz'
    );
    expect(formatHttpEndpoint('::', 80, 'healthz')).toBe('http://[::]:80/healthz');
  });

  test('does not double-bracket an already-bracketed IPv6 host', () => {
    expect(formatHttpEndpoint('[::1]', 9883)).toBe('http://[::1]:9883');
  });

  test('does not rewrite wildcard bind hosts', () => {
    expect(formatHttpEndpoint('0.0.0.0', 9883)).toBe('http://0.0.0.0:9883');
  });
});

describe('rewriteWildcardBindHost', () => {
  test('rewrites IPv4 and IPv6 wildcard binds to loopback', () => {
    expect(rewriteWildcardBindHost('0.0.0.0')).toBe('127.0.0.1');
    expect(rewriteWildcardBindHost('::')).toBe('::1');
    expect(rewriteWildcardBindHost('[::]')).toBe('::1');
  });

  test('leaves concrete hosts unchanged', () => {
    expect(rewriteWildcardBindHost('127.0.0.1')).toBe('127.0.0.1');
    expect(rewriteWildcardBindHost('::1')).toBe('::1');
    expect(rewriteWildcardBindHost('2001:db8::1')).toBe('2001:db8::1');
  });
});
