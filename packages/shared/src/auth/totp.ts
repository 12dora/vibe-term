import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { concatBytes, u32ToLe } from './encoding';

export const TOTP_SALT_PREFIX = 'tmex-totp';
export const TOTP_DEFAULT_STEP = 30;
export const TOTP_DEFAULT_DIGITS = 6;

export function deriveTotpKey(seed: Uint8Array, uid: string, rootEpoch: number): Uint8Array {
  const salt = concatBytes(utf8ToBytes(TOTP_SALT_PREFIX), u32ToLe(rootEpoch));
  const info = utf8ToBytes(uid);
  return hkdf(sha256, seed, salt, info, 32);
}

export type TotpCodeOptions = {
  step?: number;
  digits?: number;
  t0?: number;
};

function hotp(secret: Uint8Array, counter: bigint, digits: number): string {
  const msg = new Uint8Array(8);
  const view = new DataView(msg.buffer);
  view.setUint32(0, Number((counter >> 32n) & 0xffffffffn), false);
  view.setUint32(4, Number(counter & 0xffffffffn), false);
  const mac = hmac(sha1, secret, msg);
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  const mod = 10 ** digits;
  return (bin % mod).toString().padStart(digits, '0');
}

export function totpCode(secret: Uint8Array, time: number, opts: TotpCodeOptions = {}): string {
  const step = opts.step ?? TOTP_DEFAULT_STEP;
  const digits = opts.digits ?? TOTP_DEFAULT_DIGITS;
  const t0 = opts.t0 ?? 0;
  const counter = BigInt(Math.floor((time - t0) / step));
  return hotp(secret, counter, digits);
}

export function verifyTotpCode(
  secret: Uint8Array,
  code: string,
  time: number,
  opts: TotpCodeOptions = {}
): boolean {
  const step = opts.step ?? TOTP_DEFAULT_STEP;
  const t0 = opts.t0 ?? 0;
  for (const delta of [-1, 0, 1]) {
    const shifted = time + delta * step;
    if (shifted < t0) {
      continue;
    }
    if (totpCode(secret, shifted, opts) === code) {
      return true;
    }
  }
  return false;
}
