import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { sha256Hex } from './artifacts-manifest';

const SUM_LINE = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/;

export function parseSha256Sums(text: string, fileName: string): string | null {
  const want = basename(fileName);
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.trim().match(SUM_LINE);
    if (!match) continue;
    if (basename(match[2]) === want) return match[1].toLowerCase();
  }
  return null;
}

export function verifyTarballSha256(bytes: Uint8Array, expectedHex: string): boolean {
  return sha256Hex(bytes) === expectedHex.toLowerCase();
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
