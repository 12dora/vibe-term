// TOTP 密钥的 base32 编码与 otpauth URI 拼装（RFC 4648 / Key Uri Format）。

import { TOTP_DEFAULT_DIGITS, TOTP_DEFAULT_STEP, randomBytes } from '@tmex/shared/auth';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32，不带 padding（认证器普遍接受）。 */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/=+$/, '').toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`invalid base32 char: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

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
    secret: base32Encode(input.secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(input.digits ?? TOTP_DEFAULT_DIGITS),
    period: String(input.period ?? TOTP_DEFAULT_STEP),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
