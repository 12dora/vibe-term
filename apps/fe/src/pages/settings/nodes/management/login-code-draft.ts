// 「登录命令」表单草稿：目标选择与验证输入。纯函数，不碰 React。

import type { LoginCodeContext, LoginCodeProof, LoginCodeProofKind } from '@/auth/login-code-issue';
import type { LoginCodeSelection } from './login-code-request';
import { TOTP_RETRY_CODES } from './login-code-text';

export const OTP_LENGTH = 6;

export interface LoginCodeDraft {
  scope: 'all' | 'one';
  /** 指定节点时的 mesh id；null = 取第一台可用节点。 */
  nodeId: string | null;
  /** 双因素可选时的偏好；上下文里没有该项时回落到第一项。 */
  proofKind: LoginCodeProofKind;
  totp: string;
  password: string;
  passwordTotp: string;
}

export function initialDraft(selection: LoginCodeSelection): LoginCodeDraft {
  return {
    scope: selection === 'all' ? 'all' : 'one',
    nodeId: selection === 'all' ? null : selection,
    proofKind: 'totp',
    totp: '',
    password: '',
    passwordTotp: '',
  };
}

/** 实际生效的验证方式：偏好不在可选范围内就取首选。 */
export function activeProofKind(
  context: Pick<LoginCodeContext, 'proofKinds'>,
  draft: Pick<LoginCodeDraft, 'proofKind'>
): LoginCodeProofKind {
  const kinds = context.proofKinds;
  return kinds.includes(draft.proofKind) ? draft.proofKind : (kinds[0] ?? 'password');
}

/** 验证码与通行密钥同时可用时才出现切换。 */
export function hasProofSwitch(context: Pick<LoginCodeContext, 'proofKinds'>): boolean {
  return context.proofKinds.includes('totp') && context.proofKinds.includes('passkey');
}

/** 输入未完整时返回 null（生成按钮据此禁用）。 */
export function buildProof(
  context: Pick<LoginCodeContext, 'proofKinds' | 'totpEnabled'>,
  draft: LoginCodeDraft
): LoginCodeProof | null {
  const kind = activeProofKind(context, draft);
  if (kind === 'totp') {
    return draft.totp.length === OTP_LENGTH ? { kind, code: draft.totp } : null;
  }
  if (kind === 'passkey') return { kind };
  if (draft.password.length === 0) return null;
  if (!context.totpEnabled) return { kind, password: draft.password };
  return draft.passwordTotp.length === OTP_LENGTH
    ? { kind, password: draft.password, totpCode: draft.passwordTotp }
    : null;
}

/** 验证码类失败（输错 / 已用过 / 缺失）后要清掉的字段；其他失败保留输入。 */
export function draftResetForFailure(code: string): Partial<LoginCodeDraft> | null {
  return TOTP_RETRY_CODES.has(code) ? { totp: '', passwordTotp: '' } : null;
}
