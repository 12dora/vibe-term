// 凭据框的提交流程：只管「消费一次选择 → 成功 / 失败后关框」，与渲染和复用窗口无关，
// 拆出来是为了不挂 DOM 也能断言「操作结束必关框」。

import { WebAuthnError } from '@vibeterm/api-client/auth/index';
import { errorMessage } from '@vibeterm/shared';
import type { CredentialChoice } from './credential-prompt';

/** 密码派生出的根公钥与服务端下发的不一致 = 密码打错了（或后端已 rotate）。 */
export class WrongPasswordError extends Error {
  readonly code = 'ROOT_KEY_MISMATCH';
  constructor() {
    super('derived root public key does not match the server root public key');
    this.name = 'WrongPasswordError';
  }
}

/** 这类错误是「用户输入 / 仪式」层面的：留在对话框里让用户重试，而不是把框关掉。 */
export function isRetryableCredentialError(error: unknown): boolean {
  if (error instanceof WrongPasswordError) return true;
  return error instanceof WebAuthnError && error.code === 'aborted';
}

/** 对话框里的错误文案：能对上 i18n key 的返回 key，其余原样返回（对话框用 defaultValue 兜底）。 */
export function credentialErrorText(error: unknown): string {
  if (error instanceof WrongPasswordError) return 'auth.errors.ROOT_KEY_MISMATCH';
  if (error instanceof WebAuthnError) return 'auth.errors.PASSKEY_ABORTED';
  return errorMessage(error);
}

export interface PendingPrompt {
  consume: (choice: CredentialChoice) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/** 提交过程对界面状态的三个出口；`settle` 负责关框（`open = null`）并交付结果。 */
export interface PromptSink {
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  settle: (finish: (pending: PendingPrompt) => void) => void;
}

/**
 * 消费一次用户选择。成功或不可重试的失败都 `settle`（框关掉）；
 * 密码打错 / 仪式被取消留在框里，让用户直接重试。
 */
export async function submitPrompt(
  pending: PendingPrompt,
  choice: CredentialChoice,
  sink: PromptSink
): Promise<void> {
  sink.setBusy(true);
  sink.setError(null);
  try {
    const value = await pending.consume(choice);
    sink.settle((row) => row.resolve(value));
  } catch (err) {
    if (isRetryableCredentialError(err)) {
      sink.setError(credentialErrorText(err));
      sink.setBusy(false);
      return;
    }
    sink.settle((row) => row.reject(err));
  }
}
