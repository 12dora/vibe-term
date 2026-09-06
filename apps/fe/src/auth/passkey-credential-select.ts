// 断言用哪把凭证：纯判定，独立于会话钥与登录流程（`session-login.ts` 只负责编排）。

import type {
  PasskeySummary,
  PublicKeyCredentialDescriptorJSON,
} from '@vibeterm/api-client/auth/index';

/**
 * 凭证选择结果。
 *
 * - `bind`：已经能唯一确定凭证，直接写进 delegation，只做一次仪式；
 * - `browser`：**不由前端挑**，把这份列表原样交给 WebAuthn，让浏览器 / 认证器选；
 * - `none`：当前 origin 一把可用的都没有。
 */
type PasskeySelection =
  | { kind: 'bind'; credentialId: string }
  | { kind: 'browser'; allowCredentials: PublicKeyCredentialDescriptorJSON[] }
  | { kind: 'none' };

/**
 * 决定这次断言用哪把凭证。
 *
 * **绝不回退到 `allowCredentials[0]`**：用户在 node A、node B 各注册过 passkey 时，从 B 登录
 * 若 A 的凭证排在前面，盲取第一把会把仪式锁死在属于 A 的凭证上并以 `NotAllowedError` 失败
 * （见 F4-1 / F4-fix 评审 Major）。取而代之：
 *
 * - 有可信 origin 元数据（登录后的 `/api/auth/passkeys`）→ 只留 `origin` **精确相等**的，
 *   没有 rp_id 回退；一把也不剩就是 `none`。
 * - 没有元数据（登录前通常没有会话，拉不到列表）→ 交给浏览器：后端已按精确 origin 过滤过
 *   登录 options，列表里每一把都能用，由认证器决定用户手上到底有哪一把。
 *   只剩一把时退化成 `bind`（那不是「挑」，本来就只有一个候选），省掉一次探测仪式。
 */
export function selectPasskeyCredential(input: {
  allowCredentials?: PublicKeyCredentialDescriptorJSON[];
  passkeys?: PasskeySummary[] | null;
  origin: string;
  preferredId?: string;
}): PasskeySelection {
  const rows = (input.allowCredentials ?? []).filter((row) => Boolean(row.id));
  if (rows.length === 0) return { kind: 'none' };
  if (input.preferredId) {
    return rows.some((row) => row.id === input.preferredId)
      ? { kind: 'bind', credentialId: input.preferredId }
      : { kind: 'none' };
  }

  const known = input.passkeys ?? null;
  if (known && known.length > 0) {
    const byId = new Map(known.map((row) => [row.credential_id, row]));
    const sameOrigin = rows.filter((row) => byId.get(row.id)?.origin === input.origin);
    if (sameOrigin.length === 1) return { kind: 'bind', credentialId: sameOrigin[0].id };
    if (sameOrigin.length > 1) return { kind: 'browser', allowCredentials: sameOrigin };
    // 有元数据但没有一把属于当前 origin：宁可报「本入口没有可用 passkey」，
    // 也不要拿别的 origin 的凭证去发起注定失败的仪式。
    if (rows.some((row) => byId.has(row.id))) return { kind: 'none' };
  }
  if (rows.length === 1) return { kind: 'bind', credentialId: rows[0].id };
  return { kind: 'browser', allowCredentials: rows };
}
