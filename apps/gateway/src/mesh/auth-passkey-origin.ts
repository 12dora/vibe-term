// 通行密钥二次验证的 origin 归属判定。
//
// WebAuthn 断言只能在注册它的 origin 上完成，因此「是否要求二次验证」必须与
// 「本 origin 拿得出哪些凭证」用同一份口径（`handlePasskeyLoginOptions` 按精确 origin 过滤）。
// 否则换一个入口域名（中继域名 → Cloudflare 域名）后，二次验证要求成立、仪式却永远做不完，
// 密码正确也登不进去。代价是：其它 origin 上有通行密钥、本 origin 没有时，密码登录只剩
// TOTP（若已启用）把关，因此这种放行会留一条审计行。

import { encodeBase64url } from '@vibeterm/shared/auth';
import type { UserKeyRecord } from '../auth/user-store';
import { stamp } from './mesh-log';

export type PasskeyOriginScope = {
  /** 注册在当前 origin 上的凭证。 */
  here: readonly UserKeyRecord[];
  /** 名下有通行密钥，但没有一把属于当前 origin。 */
  registeredElsewhere: boolean;
};

export function passkeyOriginScope(
  keys: readonly UserKeyRecord[],
  origin: string
): PasskeyOriginScope {
  const here = keys.filter((key) => key.origin === origin);
  return { here, registeredElsewhere: here.length === 0 && keys.length > 0 };
}

/** 断言用的凭证必须就是本 origin 注册的那批，不能拿别处的凭证来顶。 */
function credentialInScope(scope: PasskeyOriginScope, credentialId: string): boolean {
  return scope.here.some((key) => encodeBase64url(key.credentialId) === credentialId);
}

function parsePasskeySecondFactor(value: unknown): { credentialId: string; sig: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const rec = value as { credential_id?: unknown; sig?: unknown };
  if (typeof rec.credential_id !== 'string' || rec.credential_id.length === 0) return null;
  if (typeof rec.sig !== 'string' || rec.sig.length === 0) return null;
  return { credentialId: rec.credential_id, sig: rec.sig };
}

export type PasskeySecondFactorGate =
  | { kind: 'skip' }
  | { kind: 'reject'; code: string }
  | { kind: 'verify'; credentialId: string; sig: string };

/**
 * 密码（root delegation）登录该怎么过通行密钥这一关：
 * 本 origin 无凭证 → 放行；有凭证 → 必须带断言，且断言绑定的凭证属于本 origin。
 */
export function gatePasskeySecondFactor(input: {
  keys: readonly UserKeyRecord[];
  origin: string;
  uid: string;
  body: unknown;
}): PasskeySecondFactorGate {
  const scope = passkeyOriginScope(input.keys, input.origin);
  if (scope.here.length === 0) {
    if (scope.registeredElsewhere) logOriginSkip(input.uid, input.origin, input.keys.length);
    return { kind: 'skip' };
  }
  const parsed = parsePasskeySecondFactor(input.body);
  if (!parsed) return { kind: 'reject', code: 'PASSKEY_REQUIRED' };
  if (!credentialInScope(scope, parsed.credentialId)) {
    return { kind: 'reject', code: 'PASSKEY_INVALID' };
  }
  return { kind: 'verify', credentialId: parsed.credentialId, sig: parsed.sig };
}

function logOriginSkip(uid: string, origin: string, keys: number): void {
  console.warn(
    stamp(
      `[auth] root login skipped passkey second factor uid=${uid} origin=${origin} keys_elsewhere=${keys}`
    )
  );
}
