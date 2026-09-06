// 单测用的发布签名夹具：一把固定的测试钥 + 现造 SHA256SUMS / 签名行。
// 真正的发布私钥只存在于 CI secret 里，测试一律走注入的钥表。

import { type ReleaseSigningKey, releaseTarballName, signReleaseSums } from '@tmex/shared';
import { rootKeyFromSeed } from '@tmex/shared/auth';
import { setReleaseSigningKeysForTests } from '../system/release-signature';

export const TEST_SIGNING_SEED = new Uint8Array(32).fill(42);

function encodeBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin);
}

export const TEST_SIGNING_KEY: ReleaseSigningKey = {
  id: 'tk',
  publicKey: encodeBase64(rootKeyFromSeed(TEST_SIGNING_SEED).publicKey),
};

/** 另一把没被内嵌的钥：用来构造「签名来自陌生钥」的用例。 */
export const FOREIGN_SIGNING_SEED = new Uint8Array(32).fill(43);
export const FOREIGN_SIGNING_KEY: ReleaseSigningKey = {
  id: 'tk',
  publicKey: encodeBase64(rootKeyFromSeed(FOREIGN_SIGNING_SEED).publicKey),
};

export function useTestSigningKeys(keys: readonly ReleaseSigningKey[] = [TEST_SIGNING_KEY]): void {
  setReleaseSigningKeysForTests(keys);
}

export function restoreSigningKeys(): void {
  setReleaseSigningKeysForTests(null);
}

export function sumsTextFor(version: string, sha256: string): string {
  return `${sha256}  ${releaseTarballName(version)}\n`;
}

export function signSums(sums: string, seed: Uint8Array = TEST_SIGNING_SEED): string {
  const key = seed === FOREIGN_SIGNING_SEED ? FOREIGN_SIGNING_KEY : TEST_SIGNING_KEY;
  return signReleaseSums(seed, sums, [key]);
}

/** 一版可直接塞进下载结果 / 清单接口的 (sums, sig)。 */
export function signedSumsFor(
  version: string,
  sha256: string,
  seed: Uint8Array = TEST_SIGNING_SEED
): { sums: string; sig: string } {
  const sums = sumsTextFor(version, sha256);
  return { sums, sig: signSums(sums, seed) };
}
