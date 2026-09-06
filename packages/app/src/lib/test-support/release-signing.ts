// 单测用的发布签名夹具：一把固定的测试钥 + 现造 SHA256SUMS / 签名行。
// 真正的发布私钥只存在于 CI secret 里，测试一律走注入的钥表。

import { rootKeyFromSeed } from '../../../../shared/src/auth/root-key';
import {
  type ReleaseSigningKey,
  signReleaseSums,
} from '../../../../shared/src/release/release-signing';
import { releaseTarballName } from '../../../../shared/src/release/source';
import { setReleaseSigningKeysForTests } from '../upgrade-verify';

const TEST_SIGNING_SEED = new Uint8Array(32).fill(42);

function encodeBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin);
}

export const TEST_SIGNING_KEY: ReleaseSigningKey = {
  id: 'tk',
  publicKey: encodeBase64(rootKeyFromSeed(TEST_SIGNING_SEED).publicKey),
};

export function useTestSigningKeys(): void {
  setReleaseSigningKeysForTests([TEST_SIGNING_KEY]);
}

export function restoreSigningKeys(): void {
  setReleaseSigningKeysForTests(null);
}

export function sumsTextFor(version: string, sha256: string): string {
  return `${sha256}  ${releaseTarballName(version)}\n`;
}

export function signSums(sums: string): string {
  return signReleaseSums(TEST_SIGNING_SEED, sums, [TEST_SIGNING_KEY]);
}
