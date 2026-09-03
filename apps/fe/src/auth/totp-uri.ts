// TOTP 密钥的 base32 编码与 otpauth URI 拼装（RFC 4648 / Key Uri Format）。

import {
  TOTP_DEFAULT_DIGITS,
  TOTP_DEFAULT_STEP,
  encodeBase32,
  randomBytes,
} from '@tmex/shared/auth';

export { encodeBase32 as base32Encode, decodeBase32 as base32Decode } from '@tmex/shared/auth';

/** TOTP 共享密钥：20 字节（HMAC-SHA1 的推荐长度）。 */
export function generateTotpSecret(): Uint8Array {
  return randomBytes(20);
}

export function buildOtpauthUri(input: {
  secret: Uint8Array;
  account: string;
  issuer?: string;
  digits?: number;
  period?: number;
}): string {
  const issuer = input.issuer ?? 'tmex';
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: encodeBase32(input.secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(input.digits ?? TOTP_DEFAULT_DIGITS),
    period: String(input.period ?? TOTP_DEFAULT_STEP),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
