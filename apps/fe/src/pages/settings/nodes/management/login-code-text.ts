// 「登录命令」对话框的文案映射：签发失败码、单台失败原因、状态徽标。

import { retryDurationText } from '@/auth/login-throttle';

type Translate = (key: string, options?: Record<string, unknown>) => string;

const NS = 'nodes.loginCode';

/** 能直接映射到 `errors.<code>` 的失败码；通行密钥的两种校验失败合并成一句。 */
const DIRECT_ERRORS = new Set([
  'TOTP_INVALID',
  'TOTP_ALREADY_USED',
  'TOTP_REQUIRED',
  'PASSKEY_CANCELLED',
  'INVALID_CREDENTIALS',
  'STEP_UP_REQUIRED',
  'NODE_PK_MISMATCH',
  'NETWORK_ERROR',
]);

/** 这些失败说明验证码输错 / 用过了：要清空输入框并重新聚焦。 */
export const TOTP_RETRY_CODES: ReadonlySet<string> = new Set([
  'TOTP_INVALID',
  'TOTP_ALREADY_USED',
  'TOTP_REQUIRED',
]);

/** 签发整体失败（`IssueLoginCodeResult` 的 `ok: false`）。 */
export function loginCodeErrorText(t: Translate, code: string, retryAfterMs?: number): string {
  if (DIRECT_ERRORS.has(code)) return t(`${NS}.errors.${code}`);
  if (code === 'PASSKEY_INVALID' || code === 'PASSKEY_REQUIRED') {
    return t(`${NS}.errors.PASSKEY_FAILED`);
  }
  if (code === 'RATE_LIMITED' || code === 'PASSWORD_LOGIN_PAUSED') {
    if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      return t(`${NS}.errors.rateLimited`, { time: retryDurationText(t, retryAfterMs) });
    }
    return t(`auth.errors.${code}`);
  }
  return t(`${NS}.errors.unknown`, { code });
}

/** 结果页里单台节点失败 / 被跳过的原因（灰字）。 */
export function loginCodeReasonText(t: Translate, code: string): string {
  switch (code) {
    case 'offline':
      return t(`${NS}.reason.offline`);
    case 'paused':
      return t(`${NS}.reason.paused`);
    case 'outdated':
    case 'OUTDATED':
      return t(`${NS}.reason.outdated`);
    case 'NETWORK_ERROR':
      return t(`${NS}.reason.unreachable`);
    case 'NODE_PK_MISMATCH':
      return t(`${NS}.reason.identity`);
    default:
      return t(`${NS}.reason.failed`, { code });
  }
}

/** 倒计时 mm:ss；负数按 0。 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
