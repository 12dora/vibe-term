import { describe, expect, test } from 'bun:test';
import { standardLoginPolicy } from '@vibeterm/shared/auth';
import { LoginPolicyLimiter } from './auth-login-limiter';
import {
  attachLoginLimiter,
  currentLoginPolicy,
  recordLoginLimitFailure,
  respondToLoginLimit,
} from './auth-login-policy-http';
import { setMeshRequestContext } from './mesh-deps';

function request(ip: string, headers: Record<string, string> = {}): Request {
  const req = new Request('http://localhost/api/auth/login', { headers });
  setMeshRequestContext(req, { via: 'self', clientIp: ip });
  return req;
}

describe('login policy http', () => {
  test('currentLoginPolicy reads the projected row and does not rebuild currentState', () => {
    let states = 0;
    const user = { id: 'user-1' };
    const store = {
      getById: (id: string) => (id === 'user-1' ? user : null),
      getByUsername: () => null,
      listCerts: () => [],
      listNodes: () => [],
      listUsers: () => [user],
    };
    const keyLog = {
      readLoginPolicy: () => standardLoginPolicy(),
      currentState: () => {
        states += 1;
        return { loginPolicy: standardLoginPolicy() };
      },
    };
    const policy = currentLoginPolicy(store as never, keyLog as never, 'user-1');
    expect(policy.preset).toBe('standard');
    expect(states).toBe(0);
  });

  test('username and uid share one account bucket; an unknown string does not pause it', () => {
    const policy = { ...standardLoginPolicy(), accountFailPerHour: 1, ipFailThreshold: 100 };
    const limiter = new LoginPolicyLimiter(
      () => 5_000,
      () => policy
    );
    const canonicalUid = (hint: string) =>
      hint === 'alice' || hint === 'user-1' ? 'user-1' : hint;
    const attempt = (uid: string, ip: string) => ({
      limiter,
      policy,
      req: request(ip),
      uidHint: uid,
      ip,
      method: 'root' as const,
      peer: false,
      canonicalUid,
      recordRejection: false,
    });
    recordLoginLimitFailure(attempt('alice', '203.0.113.1'));
    recordLoginLimitFailure(attempt('user-1', '203.0.113.2'));
    expect(respondToLoginLimit(attempt('alice', '203.0.113.3'))?.status).toBe(429);
    expect(respondToLoginLimit(attempt('mallory', '203.0.113.4'))).toBeNull();
  });

  test('entry gate counts IP only', () => {
    const policy = { ...standardLoginPolicy(), ipFailThreshold: 1, accountFailPerHour: 1 };
    const limiter = new LoginPolicyLimiter(
      () => 5_000,
      () => policy
    );
    const limits = attachLoginLimiter({
      limiter,
      policy: () => policy,
      onReject: () => undefined,
      peekUid: () => 'user-1',
      uidTooLong: () => false,
      canonicalUid: (hint) => hint,
    });
    limits.record(request('203.0.113.9'), 'user-1', '203.0.113.9');
    limits.record(request('203.0.113.10'), 'user-1', '203.0.113.10');
    expect(limits.gate(request('203.0.113.9'), 'user-1', '203.0.113.9', 'root')?.status).toBe(429);
    expect(
      respondToLoginLimit({
        limiter,
        policy,
        req: request('198.51.100.1'),
        uidHint: 'user-1',
        ip: '198.51.100.1',
        method: 'root',
        peer: false,
        canonicalUid: (hint) => hint,
        recordRejection: false,
      })
    ).toBeNull();
  });

  test('strict-local clients skip the account pause; a proxied loopback does not', () => {
    const policy = { ...standardLoginPolicy(), accountFailPerHour: 1, ipFailThreshold: 100 };
    const limiter = new LoginPolicyLimiter(
      () => 5_000,
      () => policy
    );
    const send = (ip: string, headers: Record<string, string> = {}) => {
      const req = request(ip, headers);
      const input = {
        limiter,
        policy,
        req,
        uidHint: 'user-1',
        ip,
        method: 'root' as const,
        peer: false,
        canonicalUid: (hint: string) => hint,
        recordRejection: false as const,
      };
      recordLoginLimitFailure(input);
      return respondToLoginLimit(input);
    };
    expect(send('127.0.0.1')).toBeNull();
    expect(send('192.168.1.5')).toBeNull();
    expect(send('203.0.113.1')).toBeNull();
    expect(send('203.0.113.2')?.status).toBe(429);
    expect(send('127.0.0.1')).toBeNull();
    expect(send('10.1.2.3')).toBeNull();
    expect(send('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })?.status).toBe(429);
  });
});
