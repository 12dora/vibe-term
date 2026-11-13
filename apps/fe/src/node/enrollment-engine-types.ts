import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { AuthApi, AuthModeResponse } from '@vibeterm/api-client/auth/index';
import type { AdmitFollowUp } from './admit-progress';
import type { EnrollmentApi } from './enrollment-api';

/** 签 admit 记录所需的用户身份；`ResolvedMode` 天然满足。 */
export interface AdmitMode extends Pick<AuthModeResponse, 'rootEpoch'> {
  uid: string;
}

export interface AdmitContext {
  api: AuthApi;
  /** 缺 uid / kdf 参数（还没有主用户）时为 `null`：这个消费方不参与签名。 */
  mode: AdmitMode | null;
  enrollmentApi: EnrollmentApi | null;
  prompt: CredentialPromptHandle;
  /** admit 之后还要补的那一步（中继模式下发成员密钥）；没有则 admit 落账即完成。 */
  followUp?: AdmitFollowUp | null;
  /** admit 成功后刷新列表。 */
  onDone: () => void;
  /** 消费方的翻译函数：引擎在模块级，拿不到 React 的 i18n 上下文。 */
  t: (key: string, options?: Record<string, unknown>) => string;
}

/** 绑定到某个消费方槽位的动作。 */
export interface EnrollmentEngineHandle {
  /** 「待确认 / 重试」按钮：只认 enrollment id，pending 一律从权威 store 现取。 */
  confirmManually(enrollmentId: string): Promise<void>;
  /** 「补发成员密钥」：节点已加入、第二步没签成时只补这一条。 */
  resendMemberKey(enrollmentId: string): Promise<void>;
}
