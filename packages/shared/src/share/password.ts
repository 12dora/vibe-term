import { SHARE_PASSWORD_MIN_LENGTH } from './types';

/** 去除易混淆字符 0O1lI 的大小写字母 + 数字。 */
export const SHARE_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

const REJECT_THRESHOLD = 256 - (256 % SHARE_PASSWORD_ALPHABET.length);

export function generateSharePassword(length = 8): string {
  const size = Math.max(SHARE_PASSWORD_MIN_LENGTH, Math.floor(length));
  const alphabet = SHARE_PASSWORD_ALPHABET;
  const out: string[] = [];
  const buffer = new Uint8Array(size * 2);
  while (out.length < size) {
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (byte >= REJECT_THRESHOLD) continue;
      out.push(alphabet[byte % alphabet.length] as string);
      if (out.length === size) break;
    }
  }
  return out.join('');
}
