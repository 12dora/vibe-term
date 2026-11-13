import { sha256 } from '@noble/hashes/sha2.js';

const ENROLL_SAS_DOMAIN = new TextEncoder().encode('vibeterm/enroll-sas/v1');

/** 加入确认码：新机器与确认方各自从同一张节点证书算出，人工比对一致才允许接入。 */
export function enrollSas(certificateBytes: Uint8Array): string {
  const input = new Uint8Array(ENROLL_SAS_DOMAIN.length + certificateBytes.length);
  input.set(ENROLL_SAS_DOMAIN, 0);
  input.set(certificateBytes, ENROLL_SAS_DOMAIN.length);
  const digest = sha256(input);
  const value = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  const digits = String(value % 100_000_000).padStart(8, '0');
  return `${digits.slice(0, 4)}-${digits.slice(4)}`;
}
