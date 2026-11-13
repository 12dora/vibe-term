import { describe, expect, test } from 'bun:test';
import {
  type TargetPolicyOptions,
  assertTargetAllowed,
  classifyTargetAddress,
  resolveAllowedTarget,
  resolveAllowedTargets,
} from './target-policy';
import { PortMapError } from './types';

const GATEWAY = 19_663;
const PEER = 19_883;
const TLS = 19_443;
const TURN = 3_478;
const SELF_PORTS = [GATEWAY, PEER, TLS, TURN];
const LOCAL_ADDRESSES = ['127.0.0.1', '::1', '203.0.113.7', 'fe80::1c2:3ff:fe04:506'];

function policy(records: Record<string, string[]> = {}): TargetPolicyOptions {
  return {
    resolver: async (host) => {
      const found = records[host];
      if (!found) throw new Error(`ENOTFOUND ${host}`);
      return found;
    },
    selfPorts: () => SELF_PORTS,
    localAddresses: () => LOCAL_ADDRESSES,
  };
}

function classify(address: string, port: number) {
  return classifyTargetAddress(address, port, SELF_PORTS, LOCAL_ADDRESSES);
}

async function forbiddenCode(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (err) {
    return err instanceof PortMapError ? err.code : `other:${String(err)}`;
  }
}

describe('portmap target policy', () => {
  test('refuses the node own ports on every local address form', () => {
    for (const port of SELF_PORTS) {
      for (const address of [
        '127.0.0.1',
        '127.8.9.10',
        '::1',
        '0:0:0:0:0:0:0:1',
        '::ffff:127.0.0.1',
        '::ffff:7f00:1',
        '0.0.0.0',
        '::',
        '203.0.113.7',
        '::ffff:203.0.113.7',
      ]) {
        expect(classify(address, port)).toEqual({ allowed: false, reason: 'self_service' });
      }
    }
  });

  test('allows other ports on loopback and the node own ports elsewhere', () => {
    expect(classify('127.0.0.1', 5432)).toEqual({ allowed: true });
    expect(classify('::1', 8080)).toEqual({ allowed: true });
    expect(classify('203.0.113.7', 22)).toEqual({ allowed: true });
    expect(classify('10.0.0.5', 22)).toEqual({ allowed: true });
    expect(classify('10.0.0.5', GATEWAY)).toEqual({ allowed: true });
    expect(classify('198.51.100.9', TURN)).toEqual({ allowed: true });
  });

  test('refuses link-local and cloud metadata on any port', () => {
    expect(classify('169.254.169.254', 80)).toEqual({ allowed: false, reason: 'link_local' });
    expect(classify('::ffff:169.254.169.254', 80)).toEqual({
      allowed: false,
      reason: 'link_local',
    });
    expect(classify('fe80::1', 22)).toEqual({ allowed: false, reason: 'link_local' });
    expect(classify('febf::1', 22)).toEqual({ allowed: false, reason: 'link_local' });
    expect(classify('100.100.100.200', 80)).toEqual({ allowed: false, reason: 'metadata' });
    expect(classify('::ffff:100.100.100.200', 80)).toEqual({ allowed: false, reason: 'metadata' });
    expect(classify('fd00:ec2::254', 80)).toEqual({ allowed: false, reason: 'metadata' });
    expect(classify('100.100.100.201', 80)).toEqual({ allowed: true });
    expect(classify('fd00:ec2::253', 80)).toEqual({ allowed: true });
  });

  test('fails closed on an address it cannot parse', () => {
    expect(classify('not-an-ip', 22)).toEqual({ allowed: false, reason: 'invalid_address' });
    expect(classify('1::2::3', 22)).toEqual({ allowed: false, reason: 'invalid_address' });
  });

  test('resolves literals without the resolver and returns the checked address', async () => {
    expect(await resolveAllowedTarget('10.0.0.5', 22, policy())).toBe('10.0.0.5');
    expect(await resolveAllowedTarget('127.0.0.1', 5432, policy())).toBe('127.0.0.1');
    expect(await forbiddenCode(resolveAllowedTarget('127.0.0.1', GATEWAY, policy()))).toBe(
      'target_forbidden'
    );
    expect(await forbiddenCode(resolveAllowedTarget('169.254.169.254', 80, policy()))).toBe(
      'target_forbidden'
    );
    expect(await forbiddenCode(resolveAllowedTarget('fe80::1', 22, policy()))).toBe(
      'target_forbidden'
    );
    expect(await forbiddenCode(resolveAllowedTarget('fd00:ec2::254', 80, policy()))).toBe(
      'target_forbidden'
    );
  });

  test('checks every resolved address of a hostname', async () => {
    const records = {
      'db.example.com': ['10.0.0.5'],
      'mixed.example.com': ['10.0.0.5', '127.0.0.1'],
      'self.example.com': ['127.0.0.1'],
    };
    expect(await resolveAllowedTarget('db.example.com', 22, policy(records))).toBe('10.0.0.5');
    expect(await resolveAllowedTargets('mixed.example.com', 22, policy(records))).toEqual([
      '10.0.0.5',
      '127.0.0.1',
    ]);
    expect(
      await forbiddenCode(resolveAllowedTarget('mixed.example.com', GATEWAY, policy(records)))
    ).toBe('target_forbidden');
    expect(
      await forbiddenCode(resolveAllowedTarget('self.example.com', GATEWAY, policy(records)))
    ).toBe('target_forbidden');
  });

  test('treats localhost as loopback even if the resolver says otherwise', async () => {
    const records = { localhost: ['10.0.0.5'] };
    expect(await forbiddenCode(resolveAllowedTarget('localhost', GATEWAY, policy(records)))).toBe(
      'target_forbidden'
    );
    expect(await resolveAllowedTarget('localhost', 5432, policy(records))).toBe('10.0.0.5');
  });

  test('assertTargetAllowed only raises for forbidden targets', async () => {
    expect(await forbiddenCode(assertTargetAllowed('127.0.0.1', GATEWAY, policy()))).toBe(
      'target_forbidden'
    );
    expect(await forbiddenCode(assertTargetAllowed('missing.example.com', 22, policy()))).toBe(
      null
    );
    expect(await forbiddenCode(resolveAllowedTarget('missing.example.com', 22, policy()))).toMatch(
      /^other:/
    );
  });
});
