import { describe, expect, test } from 'bun:test';
import {
  loginFailureMessage,
  loginFailureText,
  loginFailureTextFromException,
  pausedPasskeyHint,
  retryDurationText,
} from './login-throttle';

const t = (key: string, options?: Record<string, unknown>) => {
  if (key.startsWith('auth.duration.'))
    return `${options?.n}${key.slice('auth.duration.'.length, 'auth.duration.'.length + 1)}`;
  return options ? `${key}(${JSON.stringify(options)})` : key;
};

describe('retryDurationText', () => {
  test('rounds up in the natural unit', () => {
    expect(retryDurationText(t, 400)).toBe('1s');
    expect(retryDurationText(t, 42_100)).toBe('43s');
    expect(retryDurationText(t, 14 * 60_000 + 20_000)).toBe('15m');
    expect(retryDurationText(t, 90 * 60_000)).toBe('90m');
    expect(retryDurationText(t, 23.5 * 3_600_000)).toBe('24h');
    expect(retryDurationText(t, 6.2 * 86_400_000)).toBe('7d');
  });
});

describe('loginFailureText', () => {
  test('RATE_LIMITED with retryAfterMs names the wait', () => {
    expect(loginFailureText(t, { code: 'RATE_LIMITED', retryAfterMs: 900_000 }, 'password')).toBe(
      'auth.login.throttle.rateLimited({"time":"15m"})'
    );
  });

  test('RATE_LIMITED without retryAfterMs falls back to the generic line', () => {
    expect(loginFailureText(t, { code: 'RATE_LIMITED' }, 'password')).toBe(
      'auth.errors.RATE_LIMITED'
    );
  });

  test('PASSWORD_LOGIN_PAUSED suggests passkey only when usable here', () => {
    const failure = { code: 'PASSWORD_LOGIN_PAUSED', retryAfterMs: 3_600_000 };
    expect(loginFailureText(t, failure, 'password', { passkeyUsable: false })).toBe(
      'auth.login.throttle.paused({"time":"60m"})'
    );
    expect(loginFailureText(t, failure, 'password', { passkeyUsable: true })).toBe(
      'auth.login.throttle.paused({"time":"60m"})auth.login.throttle.usePasskey'
    );
    expect(loginFailureText(t, { code: 'PASSWORD_LOGIN_PAUSED' }, 'password')).toBe(
      'auth.errors.PASSWORD_LOGIN_PAUSED'
    );
  });

  test('other codes keep the existing mapping', () => {
    expect(loginFailureText(t, { code: 'INVALID_CREDENTIALS' }, 'password')).toBe(
      'auth.errors.invalidCredentials'
    );
    expect(loginFailureText(t, { code: 'WHATEVER' }, 'passkey')).toBe('auth.errors.LOGIN_FAILED');
  });
});

describe('loginFailureTextFromException', () => {
  test('reads retryAfterMs off a thrown challenge error', () => {
    const err = Object.assign(new Error('x'), { code: 'RATE_LIMITED', retryAfterMs: 30_000 });
    expect(loginFailureTextFromException(t, err, 'password')).toBe(
      'auth.login.throttle.rateLimited({"time":"30s"})'
    );
  });

  test('non-throttle errors use the exception mapping', () => {
    expect(loginFailureTextFromException(t, new Error('boom'), 'password')).toBe(
      'auth.errors.LOGIN_FAILED'
    );
  });
});

describe('pausedPasskeyHint', () => {
  test('suggests passkey only when this origin really has one', () => {
    const both = { passkeyAvailable: true, passkeysForThisOrigin: true };
    expect(pausedPasskeyHint(both, true)).toEqual({ passkeyUsable: true });
    expect(pausedPasskeyHint(both, false)).toEqual({ passkeyUsable: false });
    expect(pausedPasskeyHint({ ...both, passkeysForThisOrigin: false }, true)).toEqual({
      passkeyUsable: false,
    });
    expect(pausedPasskeyHint({ ...both, passkeyAvailable: false }, true)).toEqual({
      passkeyUsable: false,
    });
  });
});

describe('loginFailureMessage', () => {
  test('accepts a login result as well as a thrown error', () => {
    const mode = { passkeyAvailable: false, passkeysForThisOrigin: false };
    expect(
      loginFailureMessage(
        t,
        { ok: false, code: 'PASSWORD_LOGIN_PAUSED', retryAfterMs: 60_000 },
        'password',
        mode
      )
    ).toBe('auth.login.throttle.paused({"time":"1m"})');
    expect(loginFailureMessage(t, { ok: false, code: 'TOTP_INVALID' }, 'password', mode)).toBe(
      'auth.errors.TOTP_INVALID'
    );
  });
});
