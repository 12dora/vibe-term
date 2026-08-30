import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { HubApi } from '@/node/hub-api';
import type { AuthApi, AuthKdfParamsJson, AuthModeResponse } from '@tmex/api-client/auth/index';

/** 已确认带 uid / kdf 参数的 mesh 模式：管理动作都要签名，缺一不可。 */
export type ResolvedMode = AuthModeResponse & { uid: string; kdfParams: AuthKdfParamsJson };

/** 节点表与行内动作共用的依赖：hub 通道、签名凭据与刷新回调。 */
export interface NodeActionDeps {
  hubApi: HubApi | null;
  hubOnline: boolean;
  mode: ResolvedMode;
  api: AuthApi;
  prompt: CredentialPromptHandle;
  onChanged: () => void;
}

/** 没有 uid / kdf 参数时不渲染管理动作；hook 不能条件调用，故给个不会被用到的占位。 */
export const PLACEHOLDER_KDF: AuthKdfParamsJson = {
  salt: '',
  memory_kib: 0,
  iterations: 0,
  parallelism: 0,
};
