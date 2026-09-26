import { describe, expect, test } from 'bun:test';
import { LOGIN_POLICY_PRESETS, loginPolicyFromPreset } from '@vibeterm/shared/auth';
import {
  loginLimitDraft,
  parseLoginLimitDraft,
  policiesEqual,
  presetSummary,
  withPreset,
} from './login-limit-form';

const t = (key: string, o?: Record<string, unknown>) => (o ? `${key}${JSON.stringify(o)}` : key);

describe('login limit form', () => {
  test('named presets parse to the shared preset numbers', () => {
    const draft = withPreset(loginLimitDraft(loginPolicyFromPreset('standard')), 'strict');
    const parsed = parseLoginLimitDraft(t, draft);
    expect(parsed).toEqual({ ok: true, policy: loginPolicyFromPreset('strict') });
  });

  test('exemptLocal survives preset switches', () => {
    const draft = { ...loginLimitDraft(loginPolicyFromPreset('standard')), exemptLocal: false };
    const parsed = parseLoginLimitDraft(t, withPreset(draft, 'relaxed'));
    expect(parsed.ok && parsed.policy.exemptLocal).toBe(false);
  });

  test('custom starts from current numbers and round-trips', () => {
    const draft = withPreset(loginLimitDraft(loginPolicyFromPreset('strict')), 'custom');
    expect(draft.ipLockMax).toEqual({ value: '7', unit: 'days' });
    const parsed = parseLoginLimitDraft(t, draft);
    expect(parsed).toEqual({
      ok: true,
      policy: { ...loginPolicyFromPreset('strict'), preset: 'custom' },
    });
  });

  test('custom fields report range, integer and ladder errors per field', () => {
    const base = withPreset(loginLimitDraft(loginPolicyFromPreset('standard')), 'custom');
    const parsed = parseLoginLimitDraft(t, {
      ...base,
      ipFailThreshold: '2',
      accountFailPerHour: 'x',
      ipLockBase: { value: '2', unit: 'hours' },
      ipLockMax: { value: '1', unit: 'hours' },
      accountLock: { value: '2', unit: 'days' },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.ipFailThreshold).toContain('auth.security.loginLimit.errors.range');
    expect(parsed.errors.accountFailPerHour).toBe('auth.security.loginLimit.errors.integer');
    expect(parsed.errors.ipLockMax).toBe('auth.security.loginLimit.errors.maxBelowBase');
    expect(parsed.errors.accountLock).toContain('auth.duration.days');
    expect(parsed.errors.ipLockBase).toBeUndefined();
  });

  test('presetSummary renders the numbers', () => {
    const summary = presetSummary(t, LOGIN_POLICY_PRESETS.standard);
    expect(summary.ip).toContain('"count":10');
    expect(summary.ip).toContain('auth.duration.days');
    expect(summary.account).toContain('"count":50');
  });

  test('policiesEqual', () => {
    expect(policiesEqual(loginPolicyFromPreset('strict'), loginPolicyFromPreset('strict'))).toBe(
      true
    );
    expect(
      policiesEqual(loginPolicyFromPreset('strict'), loginPolicyFromPreset('strict', false))
    ).toBe(false);
  });
});
