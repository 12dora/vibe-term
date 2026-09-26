import { describe, expect, test } from 'bun:test';
import { standardLoginPolicy } from '@vibeterm/shared/auth';
import { claimedProxyClient, loginIpExempt, loginLimiterIp } from './auth-login-ip';
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

  test('claimed address prefers CF, then X-Real-IP, then the last XFF hop, then Forwarded', () => {
    expect(
      claimedProxyClient(
        new Headers({
          'cf-connecting-ip': '203.0.113.1',
          'x-real-ip': '203.0.113.2',
          'x-forwarded-for': '198.51.100.1, 198.51.100.2',
        })
      )
    ).toBe('203.0.113.1');
    expect(claimedProxyClient(new Headers({ 'x-real-ip': '203.0.113.2' }))).toBe('203.0.113.2');
    expect(
      claimedProxyClient(new Headers({ 'x-forwarded-for': '198.51.100.1, 198.51.100.2' }))
    ).toBe('198.51.100.2');
    expect(
      claimedProxyClient(new Headers({ forwarded: 'for=192.0.2.1, for="[2001:db8::1]"' }))
    ).toBe('2001:db8::1');
  });
});
