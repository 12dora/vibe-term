import { describe, expect, test } from 'bun:test';
import { standardLoginPolicy } from '@vibeterm/shared/auth';
import { loginIpExempt, loginLimiterIp } from './auth-login-ip';
import { setMeshRequestContext } from './mesh-deps';

function req(ip: string, headers: Record<string, string> = {}, trustProxy = false): Request {
  const request = new Request('http://localhost/api/auth/login', { headers });
  setMeshRequestContext(request, { via: 'self', clientIp: ip, trustProxy });
  return request;
}

describe('login limiter IP key', () => {
  test('untrusted proxy headers bucket by the claimed address', () => {
    const attacker = req('127.0.0.1', { 'x-forwarded-for': '203.0.113.4' });
    const owner = req('127.0.0.1', { 'x-forwarded-for': '198.51.100.7' });
    expect(loginLimiterIp(attacker)).toBe('proxied:203.0.113.4');
    expect(loginLimiterIp(owner)).toBe('proxied:198.51.100.7');
    expect(loginLimiterIp(attacker)).not.toBe(loginLimiterIp(owner));
  });

  test('trust-proxy uses the resolved address and still does not exempt', () => {
    const policy = standardLoginPolicy();
    const request = req('127.0.0.1', { 'x-forwarded-for': '203.0.113.4' }, true);
    expect(loginLimiterIp(request)).toBe('203.0.113.4');
    expect(loginIpExempt(policy, request)).toBe(false);
  });

  test('loopback and LAN without proxy headers are IP-exempt when the policy says so', () => {
    const policy = standardLoginPolicy();
    expect(loginIpExempt(policy, req('127.0.0.1'))).toBe(true);
    expect(loginIpExempt(policy, req('10.1.2.3'))).toBe(true);
    expect(loginIpExempt(policy, req('203.0.113.9'))).toBe(false);
    expect(loginIpExempt({ exemptLocal: false }, req('127.0.0.1'))).toBe(false);
    expect(loginIpExempt(policy, req('127.0.0.1', { forwarded: 'for=203.0.113.1' }))).toBe(false);
  });

  test('untrusted claim reads only the configured header; rotating X-Real-IP stays in one bucket', () => {
    const a = req('127.0.0.1', { 'x-real-ip': '203.0.113.1' });
    const b = req('127.0.0.1', { 'x-real-ip': '203.0.113.2' });
    expect(loginLimiterIp(a)).toBe('proxied:unknown');
    expect(loginLimiterIp(b)).toBe(loginLimiterIp(a));
    const both = req('127.0.0.1', {
      'cf-connecting-ip': '203.0.113.1',
      'x-forwarded-for': '198.51.100.1, 198.51.100.2',
    });
    expect(loginLimiterIp(both)).toBe('proxied:198.51.100.2');
  });

  test('public socket buckets by the socket whatever headers it sends', () => {
    for (const trustProxy of [false, true]) {
      const spoof = req(
        '203.0.113.5',
        { 'x-real-ip': '10.0.0.1', 'x-forwarded-for': '1.1.1.1' },
        trustProxy
      );
      expect(loginLimiterIp(spoof)).toBe('203.0.113.5');
    }
  });

  test('trusted proxy rewrote XFF; a forged X-Real-IP neither picks the bucket nor exempts', () => {
    const request = req(
      '127.0.0.1',
      { 'x-real-ip': '127.0.0.1', 'x-forwarded-for': '198.51.100.7' },
      true
    );
    expect(loginLimiterIp(request)).toBe('198.51.100.7');
    expect(loginIpExempt(standardLoginPolicy(), request)).toBe(false);
  });

  test('IPv6 clients are bucketed by /64', () => {
    expect(loginLimiterIp(req('2001:db8:1:2::a'))).toBe('2001:db8:1:2::/64');
    expect(loginLimiterIp(req('2001:db8:1:2:ffff::b'))).toBe('2001:db8:1:2::/64');
    expect(loginLimiterIp(req('::1', { 'x-forwarded-for': '2001:db8:9:9::1' }, true))).toBe(
      '2001:db8:9:9::/64'
    );
  });

  test('missing socket IP is the unknown bucket and never exempt', () => {
    const request = new Request('http://localhost/api/auth/login');
    setMeshRequestContext(request, { via: 'self' });
    expect(loginLimiterIp(request)).toBe('unknown');
    expect(loginIpExempt(standardLoginPolicy(), request)).toBe(false);
  });
});
