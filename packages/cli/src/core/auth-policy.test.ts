import { describe, expect, test } from 'bun:test';
import { LOGIN_POLICY_PRESETS } from '@vibeterm/shared/auth';
import { buildPolicyFromFlags, formatPolicyLines, parsePolicySnapshot } from './auth-policy';
import { UsageError } from './errors';

describe('buildPolicyFromFlags', () => {
  test('presets copy the contract numbers and exempt local by default', () => {
    const policy = buildPolicyFromFlags({ preset: 'strict' });
    expect(policy).toEqual({
      preset: 'strict',
      exemptLocal: true,
      ...LOGIN_POLICY_PRESETS.strict,
    });
    expect(policy.ipFailThreshold).toBe(5);
    expect(policy.ipLockBaseMs).toBe(30 * 60_000);
    expect(policy.ipLockMaxMs).toBe(7 * 86_400_000);
    expect(policy.accountFailPerHour).toBe(20);
    expect(policy.accountLockMs).toBe(3_600_000);
  });

  test('custom flags parse durations and can turn off the local exemption', () => {
    const policy = buildPolicyFromFlags({
      custom: true,
      'ip-threshold': 8,
      'ip-lock': '15m',
      'ip-lock-max': '24h',
      'account-per-hour': 40,
      'account-lock': '15m',
      'no-exempt-local': true,
    });
    expect(policy.preset).toBe('custom');
    expect(policy.exemptLocal).toBe(false);
    expect(policy.ipLockBaseMs).toBe(15 * 60_000);
    expect(policy.ipLockMaxMs).toBe(24 * 3_600_000);
  });

  test('rejects a custom lock outside the contract range', () => {
    expect(() =>
      buildPolicyFromFlags({
        custom: true,
        'ip-threshold': 8,
        'ip-lock': '30s',
        'ip-lock-max': '24h',
        'account-per-hour': 40,
        'account-lock': '15m',
      })
    ).toThrow(UsageError);
    expect(() => buildPolicyFromFlags({ preset: 'standard', custom: true })).toThrow(UsageError);
    expect(() => buildPolicyFromFlags({})).toThrow(UsageError);
  });
});

describe('parsePolicySnapshot', () => {
  test('prints preset, source, and blockers', () => {
    const snapshot = parsePolicySnapshot({
      policy: {
        preset: 'standard',
        ipFailThreshold: 10,
        ipLockBaseMs: 15 * 60_000,
        ipLockMaxMs: 24 * 3_600_000,
        accountFailPerHour: 50,
        accountLockMs: 15 * 60_000,
        exemptLocal: true,
      },
      source: 'default',
      writable: false,
      blockers: [{ nodeId: 'b'.repeat(32), name: 'legacy', version: '2.9.0' }],
    });
    const text = formatPolicyLines(snapshot).join('\n');
    expect(text).toContain('preset: standard');
    expect(text).toContain('source: default');
    expect(text).toContain('writable: no');
    expect(text).toContain('ip lock: 15m (max 24h)');
    expect(text).toContain('legacy');
    expect(text).toContain('2.9.0');
  });
});
