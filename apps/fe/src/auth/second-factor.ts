// 密码登录第二步的判定（服务端契约见 docs/security/login-security.md §4）。
//
// 服务端自 83729bfb 起改成 **OR**：同时启用 TOTP 与本 origin 通行密钥时，交任一因子即可。
// `/api/auth/mode` 的 `secondFactorPolicy` 是加性字段，旧节点不下发——**缺失即按旧的 AND 处理**，
// 否则在未升级的节点上跳过仪式只会换来一次 `PASSKEY_REQUIRED` 往返。

import type { AuthModeResponse } from '@vibeterm/api-client/auth/index';

export type SecondFactorMode = Pick<AuthModeResponse, 'passkeySecondFactor' | 'secondFactorPolicy'>;

/**
 * 这次密码登录要不要先做一次通行密钥仪式。
 *
 * `either` + 用户已输验证码 → 不弹仪式：验证码单独就能过这一关，多弹一次指纹是纯粹的打扰。
 * 判错也不致命——服务端回 `PASSKEY_REQUIRED` 时 `loginToNode()` 会当场补一次仪式再重试。
 */
export function shouldRunPasskeySecondFactor(
  mode: SecondFactorMode,
  hasTotpCode: boolean
): boolean {
  if (!mode.passkeySecondFactor) return false;
  return !(hasTotpCode && mode.secondFactorPolicy === 'either');
}

/**
 * 验证码输入框下的一行说明：两种因子都配齐时，验证码可以代替通行密钥仪式。
 * 其余情形不给说明——验证码本来就是唯一的第二步，多一行只会占地方。
 */
export function totpSecondFactorHintKey(mode: SecondFactorMode): string | null {
  if (!mode.passkeySecondFactor || mode.secondFactorPolicy !== 'either') return null;
  return 'auth.login.totpInsteadOfPasskey';
}
