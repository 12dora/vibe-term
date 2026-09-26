// 登录被限流（`RATE_LIMITED`）或密码登录被暂停（`PASSWORD_LOGIN_PAUSED`）时的文案：
// 带上服务端给的剩余时长；暂停只挡密码登录，本地址有通行密钥时顺带指出替代方式。

import type { AuthModeResponse } from '@vibeterm/api-client/auth/index';
import { isWebAuthnAvailable } from '@vibeterm/api-client/auth/index';
import { type LoginMethod, loginErrorKey, loginErrorKeyFromException } from './login-errors';

type Translate = (key: string, options?: Record<string, unknown>) => string;

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface LoginFailureInfo {
  code?: string | null;
  retryAfterMs?: number;
}

/** 剩余时长，向上取整：「还差 14 分 20 秒」说成「15 分钟」，不会让人提前重试又撞一次。 */
export function retryDurationText(t: Translate, ms: number): string {
  if (ms < MINUTE_MS)
    return t('auth.duration.seconds', { n: Math.max(1, Math.ceil(ms / SECOND_MS)) });
  if (ms < 2 * HOUR_MS) return t('auth.duration.minutes', { n: Math.ceil(ms / MINUTE_MS) });
  if (ms < 2 * DAY_MS) return t('auth.duration.hours', { n: Math.ceil(ms / HOUR_MS) });
  return t('auth.duration.days', { n: Math.ceil(ms / DAY_MS) });
}

function hasRetry(ms: number | undefined): ms is number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0;
}

/** 登录失败的整句文案；`passkeyUsable` 为真时，暂停提示后补一句「通行密钥登录不受影响」。 */
export function loginFailureText(
  t: Translate,
  failure: LoginFailureInfo,
  method: LoginMethod,
  opts: { passkeyUsable: boolean } = { passkeyUsable: false }
): string {
  const retry = failure.retryAfterMs;
  if (failure.code === 'PASSWORD_LOGIN_PAUSED') {
    const base = hasRetry(retry)
      ? t('auth.login.throttle.paused', { time: retryDurationText(t, retry) })
      : t('auth.errors.PASSWORD_LOGIN_PAUSED');
    return opts.passkeyUsable ? `${base}${t('auth.login.throttle.usePasskey')}` : base;
  }
  if (failure.code === 'RATE_LIMITED' && hasRetry(retry)) {
    return t('auth.login.throttle.rateLimited', { time: retryDurationText(t, retry) });
  }
  return t(loginErrorKey(failure.code, method));
}

/** 抛出来的异常同样可能带 `retryAfterMs`（challenge 被限流）。 */
export function loginFailureTextFromException(
  t: Translate,
  error: unknown,
  method: LoginMethod,
  opts?: { passkeyUsable: boolean }
): string {
  const info = error as LoginFailureInfo | null;
  if (info?.code === 'PASSWORD_LOGIN_PAUSED' || info?.code === 'RATE_LIMITED') {
    return loginFailureText(t, { code: info.code, retryAfterMs: info.retryAfterMs }, method, opts);
  }
  return t(loginErrorKeyFromException(error, method));
}

/** 把服务端给的 `retryAfterMs` 带到登录结果上（来源是 `LoginResult` 或 challenge 抛出的异常）。 */
export function withRetryAfter(
  failure: { ok: false; code: string },
  source: unknown
): { ok: false; code: string; retryAfterMs?: number } {
  const retryAfterMs = (source as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof retryAfterMs === 'number' ? { ...failure, retryAfterMs } : failure;
}

/** 密码登录被暂停时，本地址确实能用通行密钥登录才提示改用它。 */
export function pausedPasskeyHint(
  mode: Pick<AuthModeResponse, 'passkeyAvailable' | 'passkeysForThisOrigin'>,
  webauthnSupported: boolean = isWebAuthnAvailable()
): { passkeyUsable: boolean } {
  return {
    passkeyUsable:
      webauthnSupported && Boolean(mode.passkeyAvailable) && Boolean(mode.passkeysForThisOrigin),
  };
}

/** 登录页用：失败结果或异常 → 整句文案，暂停时按 mode 决定是否建议通行密钥。 */
export function loginFailureMessage(
  t: Translate,
  source: unknown,
  method: LoginMethod,
  mode: Pick<AuthModeResponse, 'passkeyAvailable' | 'passkeysForThisOrigin'>
): string {
  return loginFailureTextFromException(t, source, method, pausedPasskeyHint(mode));
}
