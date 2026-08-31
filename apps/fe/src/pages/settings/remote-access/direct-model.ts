// 「直接连接」路径的纯推导：访问保护档位、启用本机登录的表单校验与错误码映射。
// 与 React 无关，便于脱离 DOM 直接测。

import type { LocalAuthStatus } from '@tmex/shared';

/**
 * 直连场景下这台机器的访问保护档位：
 * `node`  —— hub/node 角色，登录门由 mesh 提供，本机登录开关不适用（`supported === false`）；
 * `local` —— standalone 且本机登录已生效；
 * `unprotected` —— standalone 但门没生效，公网直连等于裸奔；
 * `unknown` —— 后端没下发 `localAuth`（旧版本 / 状态还没加载完），
 *              **不能**退化成 `unprotected`，那会把已受保护的实例误报成裸奔。
 */
export type DirectProtection = 'unknown' | 'node' | 'local' | 'unprotected';

export function directProtection(localAuth: LocalAuthStatus | null | undefined): DirectProtection {
  if (!localAuth) return 'unknown';
  if (!localAuth.supported) return 'node';
  return localAuth.effective ? 'local' : 'unprotected';
}

/** 只有明确查到有门才算受保护：`unknown` 一律按未确认处理。 */
export function directProtected(localAuth: LocalAuthStatus | null | undefined): boolean {
  const protection = directProtection(localAuth);
  return protection === 'node' || protection === 'local';
}

/** 开启本机登录的下一步：没有任何可登录用户时要先建一位，否则只需拨开关。 */
export type DirectEnableStage = 'bootstrap' | 'enable';

export function directEnableStage(
  localAuth: LocalAuthStatus | null | undefined
): DirectEnableStage {
  return localAuth?.credentialsPresent ? 'enable' : 'bootstrap';
}

/** 与后端 `local-auth-settings.ts` 保持一致：这里只做即时反馈，真正把关在后端。 */
const USERNAME = /^[A-Za-z0-9._-]{1,64}$/;
export const LOCAL_AUTH_MIN_PASSWORD = 8;

export interface BootstrapDraft {
  username: string;
  password: string;
  confirm: string;
}

export type BootstrapDraftError = 'username' | 'password' | 'confirm' | null;

export function bootstrapDraftError(draft: BootstrapDraft): BootstrapDraftError {
  if (!USERNAME.test(draft.username)) return 'username';
  if (draft.password.length < LOCAL_AUTH_MIN_PASSWORD) return 'password';
  if (draft.password !== draft.confirm) return 'confirm';
  return null;
}

/** 后端 `{code}` → 文案片段。未知码统一落到 `unknown`，不把裸 code 甩给用户。 */
const ERROR_SLUG: Record<string, string> = {
  not_standalone: 'notStandalone',
  LOCAL_ONLY: 'localOnly',
  CREDENTIALS_REQUIRED: 'credentialsRequired',
  LOCAL_AUTH_ENABLED: 'alreadyEnabled',
  CREDENTIALS_EXIST: 'credentialsExist',
  invalid_username: 'invalidUsername',
  weak_password: 'weakPassword',
  MALFORMED: 'malformed',
};

export function localAuthErrorKey(code: string): string {
  return `settings.remoteAccess.direct.errors.${ERROR_SLUG[code] ?? 'unknown'}`;
}
