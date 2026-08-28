import {
  deriveTotpKey,
  encodeBase64url,
  totpCode,
} from '../../../packages/shared/src/auth/index.ts';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(input: string): Uint8Array {
  const cleaned = input.toUpperCase().replace(/[\s=]+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) {
      throw new Error(`invalid base32: ${ch}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function parseOtpauthSecret(uri: string): string {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`invalid otpauth uri: ${uri}`);
  }
  if (parsed.protocol !== 'otpauth:') {
    throw new Error(`invalid otpauth uri: ${uri}`);
  }
  const secret = parsed.searchParams.get('secret');
  if (!secret) {
    throw new Error('otpauth uri missing secret');
  }
  return secret;
}

export function resolveTotpCode(input: {
  totp?: string | boolean;
  totpSecret?: string | boolean;
  envTotp?: string;
  nowSec?: number;
}): string | undefined {
  if (typeof input.totp === 'string' && input.totp.length > 0) {
    return input.totp;
  }
  if (typeof input.envTotp === 'string' && input.envTotp.length > 0) {
    return input.envTotp;
  }
  if (typeof input.totpSecret === 'string' && input.totpSecret.length > 0) {
    const secret = decodeBase32(input.totpSecret);
    return totpCode(secret, input.nowSec ?? Math.floor(Date.now() / 1000));
  }
  return undefined;
}

export function totpLoginField(
  seed: Uint8Array,
  uid: string,
  rootEpoch: number,
  code: string
): { code: string; k_totp: string } {
  return {
    code,
    k_totp: encodeBase64url(deriveTotpKey(seed, uid, rootEpoch)),
  };
}
