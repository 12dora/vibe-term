// 分享端点契约错误码（plan §2.2）与它们的 i18n key。
//
// 刻意**不**从 `./index` 导出：`share.*` 在 rest 语言包里，而 index 处在前端入口的静态
// import 图上，core 覆盖守卫会因此要求这些 key 进 core。分享弹窗与设置页都是懒加载 chunk，
// 直接 `@vibeterm/api-client/share-errors` 引用即可。

import { ApiError } from './client';

export const SHARE_ERROR_CODES = [
  'SHARE_NOT_FOUND',
  'SHARE_WINDOW_NOT_FOUND',
  'SHARE_PASSWORD_TOO_SHORT',
  'SHARE_PASSWORD_UNAVAILABLE',
  'SHARE_ORIGIN_INVALID',
  'SHARE_ENDED',
  'SHARE_AUTH_REQUIRED',
] as const;

/** 少数错误码的文案不按 `share.error.<code>` 命名，这里点名覆盖。 */
const SHARE_ERROR_KEY_OVERRIDES: Readonly<Record<string, string>> = {
  SHARE_PASSWORD_UNAVAILABLE: 'share.error.passwordUnavailable',
};

export type ShareErrorCode = (typeof SHARE_ERROR_CODES)[number];

const KNOWN_SHARE_ERROR_CODES = new Set<string>(SHARE_ERROR_CODES);

export const SHARE_GENERIC_ERROR_KEY = 'share.error.generic';

/**
 * 分享请求失败的 i18n key。服务端 message 是英文，直接 toast 会在中文界面里混进英文，
 * 所以只认契约错误码；网关没给码（网络故障、反代 5xx）时统一走通用兜底。
 */
export function shareErrorKey(error: unknown): string {
  const code = error instanceof ApiError ? error.code : null;
  if (!code || !KNOWN_SHARE_ERROR_CODES.has(code)) return SHARE_GENERIC_ERROR_KEY;
  return SHARE_ERROR_KEY_OVERRIDES[code] ?? `share.error.${code}`;
}
