// 「登录命令」入口的可用条件。单独成模块、只带类型 import：侧栏（入口 chunk）要用它，
// 不能顺带把 login-code-eligibility 里的版本比较等依赖拖进首屏。

import type { AuthModeResponse } from '@vibeterm/api-client/auth/index';

/**
 * 「登录命令」入口（侧栏「一键登录」与节点页卡头）的可用条件：mesh 模式，且账户凭据已就绪
 * （与节点管理卡里 `hasCredentials` 同口径）；standalone / 模式未落定都不出现。
 */
export function canUseLoginCode(
  mode: Pick<AuthModeResponse, 'mode' | 'uid' | 'kdfParams'> | null | undefined
): boolean {
  return mode?.mode === 'mesh' && Boolean(mode.uid && mode.kdfParams);
}
