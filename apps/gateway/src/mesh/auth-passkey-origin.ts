// 通行密钥二次验证的 origin 归属判定。
//
// WebAuthn 断言只能在注册它的 origin 上完成，因此「本 origin 要不要断言」必须与
// 「本 origin 拿得出哪些凭证」用同一份口径（`handlePasskeyLoginOptions` 按精确 origin 过滤）。
// 否则换一个入口域名（中继域名 → Cloudflare 域名）后，要求成立、仪式却永远做不完。
//
// 但 `Origin` 头不可验证：单凭「本 origin 没有凭证」就放行，等于拿到密码的人随便伪造一个
// 陌生 Origin 就能绕过二次验证。因此本 origin 无凭证时只有三条放行路径：名下压根没有通行
// 密钥、本次登录已过 TOTP、或该 origin 就是服务端自己配置的入口地址（站点 URL / 隧道域名 /
// hub 公网地址 / 中继访问地址，见 auth-passkey-origin-entry.ts）。都不成立就回
// `PASSKEY_REQUIRED`，由登录页指路（本机登录，或 CLI 移除通行密钥）。

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
  // 凭证归属与入口比对必须用同一把尺子，否则大小写 / 默认端口 / 尾斜杠的变体会一边落空、
  // 一边命中，正好凑出「这里没有凭证，但这是已知入口」的放行组合。
  const target = canonicalOrigin(origin);
  const here = target === null ? [] : keys.filter((key) => canonicalOrigin(key.origin) === target);
  return { here, registeredElsewhere: here.length === 0 && keys.length > 0 };
}

/**
 * WebAuthn origin 的规范形态：小写 scheme + host，省略默认端口，无路径与尾斜杠。
 * 浏览器发出的 `Origin` 永远长这样，`new URL(...).origin` 也是。
 */
export function canonicalOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

/** 两个地址是否指向同一个 origin（用于凭证归属、可用性标记）。 */
export function sameCanonicalOrigin(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  const canonical = canonicalOrigin(left);
  return canonical !== null && canonical === canonicalOrigin(right);
}

/** 请求 origin 是不是服务端自己认得的入口地址。 */
export function isKnownEntryOrigin(
  origin: string,
  entryOrigins: readonly (string | null | undefined)[]
): boolean {
  const target = canonicalOrigin(origin);
  if (!target) return false;
  return entryOrigins.some((entry) => canonicalOrigin(entry) === target);
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

export type PasskeySecondFactorInput = {
  keys: readonly UserKeyRecord[];
  origin: string;
  uid: string;
  body: unknown;
  /**
   * 本次登录已经过了 TOTP（账户开了两步验证）。`verifySecondFactors` 先跑 TOTP、失败即返回，
   * 所以能走到这一关就等于 TOTP 已验证。
   */
  totpVerified: boolean;
  /** 服务端配置里的入口地址；伪造的 Origin 不在其中。 */
  entryOrigins: readonly (string | null | undefined)[];
};

/** 密码（root delegation）登录该怎么过通行密钥这一关。 */
export function gatePasskeySecondFactor(input: PasskeySecondFactorInput): PasskeySecondFactorGate {
  // 非规范形态的 Origin 只可能是手工构造的：名下有通行密钥时一律拒绝，
  // 不给「变体绕开凭证归属、又命中已知入口」留缝。
  if (input.keys.length > 0 && canonicalOrigin(input.origin) !== input.origin) {
    return { kind: 'reject', code: 'PASSKEY_REQUIRED' };
  }
  const scope = passkeyOriginScope(input.keys, input.origin);
  if (scope.here.length > 0) return verifyAgainstScope(scope, input.body);
  // 名下一把通行密钥都没有：这一关本来就不存在。
  if (!scope.registeredElsewhere) return { kind: 'skip' };
  if (input.totpVerified) return skipWithAudit(input, 'totp');
  if (isKnownEntryOrigin(input.origin, input.entryOrigins)) return skipWithAudit(input, 'entry');
  return { kind: 'reject', code: 'PASSKEY_REQUIRED' };
}

function verifyAgainstScope(scope: PasskeyOriginScope, body: unknown): PasskeySecondFactorGate {
  const parsed = parsePasskeySecondFactor(body);
  if (!parsed) return { kind: 'reject', code: 'PASSKEY_REQUIRED' };
  if (!credentialInScope(scope, parsed.credentialId)) {
    return { kind: 'reject', code: 'PASSKEY_INVALID' };
  }
  return { kind: 'verify', credentialId: parsed.credentialId, sig: parsed.sig };
}

function skipWithAudit(
  input: PasskeySecondFactorInput,
  reason: 'totp' | 'entry'
): PasskeySecondFactorGate {
  console.warn(
    stamp(
      `[auth] root login skipped passkey second factor uid=${input.uid} origin=${input.origin} keys_elsewhere=${input.keys.length} reason=${reason}`
    )
  );
  return { kind: 'skip' };
}
