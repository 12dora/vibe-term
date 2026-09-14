import { RELAY_ENROLLMENT_NO_RELAY, RELAY_ENROLL_FANOUT_FAILED } from '@/node/relay-join';
import { errorMessage } from '@vibeterm/shared';

/** 管理动作失败的文案：带 `code` 的错误走 i18n 错误表，其余原样用异常信息。 */
export function actionErrorText(
  t: (key: string, options?: Record<string, unknown>) => string,
  err: unknown
): string {
  const code = (err as { code?: string })?.code;
  // fan-out 一台都没成：这一条不在 `auth.errors` 表里，且原始 message 是给日志看的。
  // 两个码是同一件事——网关端判出来是 502 `RELAY_ENROLL_FANOUT_FAILED`，
  // 本地按逐台结果判出来是 `RELAY_ENROLLMENT_NO_RELAY`（只有旧网关会走到）。
  if (code === RELAY_ENROLLMENT_NO_RELAY || code === RELAY_ENROLL_FANOUT_FAILED) {
    return t('nodes.enrollment.relayNoneAccepted');
  }
  if (code) return t(`auth.errors.${code}`, { defaultValue: code });
  return errorMessage(err);
}
