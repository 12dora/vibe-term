import type { AuthKdfParamsJson, AuthModeResponse } from '@tmex/api-client/auth/index';

/** 已确认带 uid / kdf 参数的 mesh 模式：管理动作都要签名，缺一不可。 */
export type ResolvedMode = AuthModeResponse & { uid: string; kdfParams: AuthKdfParamsJson };

/** 没有 uid / kdf 参数时不渲染管理动作；hook 不能条件调用，故给个不会被用到的占位。 */
export const PLACEHOLDER_KDF: AuthKdfParamsJson = {
  salt: '',
  memory_kib: 0,
  iterations: 0,
  parallelism: 0,
};
