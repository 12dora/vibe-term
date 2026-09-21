// 登录失败 → 界面上那一行原因的 i18n key。
//
// 与 `./login-failure-kind` 分开是为了让分类那一份保持零 import：`session-key-store` 现在要
// import `node-login-retry`（记账收在 `ensureNodeLogin` 里），而 `node-login-retry` import 分类，
// 分类再 import `session-key-store` 就成环。这里不在那条链上，可以随便取会话信息。

import { loginErrorKey } from './login-errors';
import { isUnreachableLoginFailure } from './login-failure-kind';
import { getSessionKey } from './session-key-store';

/**
 * 失败原因文案 key；没有码（还没失败过）返回 `null`。
 *
 * 打不通分两句：退避还排着才说「稍后自动重试」，重试额度用完就只报状态——那时界面必须同时
 * 给出「重试连接」，否则用户看着一句不会兑现的承诺，还点不了任何东西。
 * 其余按现有分表取原因；同一个签名类错误在密码 / passkey 两条路径下含义完全不同，
 * 因此按当前会话的方式取文案。
 */
export function nodeLoginFailureTextKey(
  code: string | null | undefined,
  retrying = false
): string | null {
  if (!code) return null;
  if (isUnreachableLoginFailure(code)) {
    return retrying ? 'auth.node.unreachable' : 'auth.node.unreachableStalled';
  }
  return loginErrorKey(code, getSessionKey()?.method === 'passkey' ? 'passkey' : 'password');
}
