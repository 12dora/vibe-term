import type { AuthKdfParamsJson, AuthModeResponse } from '@tmex/api-client/auth/index';
import type { PasswordChangeFeedback } from '../account-security-password';

/** 动作成功后的反馈：由哪一块发出的（决定摆在哪里）、什么调子、什么文案。 */
export interface SecurityActionFeedback extends PasswordChangeFeedback {
  section: 'password' | 'totp';
}

/** 已确认存在用户与 kdf 参数的 mode（各 Section 都依赖这两项）。 */
export type ResolvedMode = AuthModeResponse & { uid: string; kdfParams: AuthKdfParamsJson };
