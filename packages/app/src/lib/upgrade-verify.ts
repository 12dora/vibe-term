import {
  RELEASE_SIGNING_KEYS,
  RELEASE_SIGNING_SINCE,
  type ReleaseSigningKey,
  releaseSignatureRequired,
  verifyReleaseSums,
} from '../../../shared/src/release/release-signing';
import { releaseTarballName } from '../../../shared/src/release/source';
import { parseSha256Sums } from '../../../shared/src/release/verify';
import { compareSemver } from '../../../shared/src/semver';
import { t } from '../i18n';
import { sha256Hex } from './artifacts-manifest';

export { parseSha256Sums };
export { RELEASE_SIGNING_SINCE };

export const SHA256SUMS_REQUIRED_SINCE = '1.1.4';

export function sha256SumsRequired(version: string): boolean {
  const cmp = compareSemver(version, SHA256SUMS_REQUIRED_SINCE);
  if (cmp === null) throw new Error(t('errors.version.invalid', { input: version }));
  return cmp >= 0;
}

export function verifyTarballSha256(bytes: Uint8Array, expectedHex: string): boolean {
  return sha256Hex(bytes) === expectedHex.toLowerCase();
}

export type ReleaseIntegritySums = {
  hex: string | null;
  missing: boolean;
  unpublished?: boolean;
};

export function assertReleaseIntegrity(
  version: string,
  bytes: Uint8Array,
  sums: ReleaseIntegritySums,
  opts: { allowUnverified?: boolean; fileName?: string } = {}
): void {
  const fileName = opts.fileName ?? releaseTarballName(version);
  const required = sha256SumsRequired(version);

  if (required) {
    if (sums.unpublished || sums.missing || !sums.hex) {
      throw new Error(t('upgrade.integrityRequired', { version }));
    }
    if (!verifyTarballSha256(bytes, sums.hex)) {
      throw new Error(t('upgrade.integrityMismatch', { file: fileName }));
    }
    return;
  }

  // < 1.1.4 且 --allow-unverified：commands/upgrade.ts 占用中，须保留此兼容分支。
  if (sums.unpublished === true) {
    if (!opts.allowUnverified) {
      throw new Error(t('upgrade.integrityUnverifiedDenied', { version }));
    }
    return;
  }

  if (!sums.hex) {
    throw new Error(t('upgrade.integrityMissingEntry', { file: fileName }));
  }
  if (!verifyTarballSha256(bytes, sums.hex)) {
    throw new Error(t('upgrade.integrityMismatch', { file: fileName }));
  }
}

let signingKeysOverride: readonly ReleaseSigningKey[] | null = null;

/** 单测注入用的钥表；非 test 环境调用直接抛错，正式路径永远只认内嵌公钥。 */
export function setReleaseSigningKeysForTests(keys: readonly ReleaseSigningKey[] | null): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('release signing keys can only be overridden in tests');
  }
  signingKeysOverride = keys;
}

/**
 * 校验发行包签名。`RELEASE_SIGNING_SINCE` 起必须有签名；更早的版本允许没有，
 * 但只要给了签名就必须验得过——签名坏了永远是拒绝，不因为版本老而放行。
 */
export function assertReleaseSignature(
  version: string,
  sumsText: string,
  sigLine: string | null
): void {
  if (!sigLine) {
    if (!releaseSignatureRequired(version)) return;
    throw new Error(t('upgrade.signatureRequired', { version, since: RELEASE_SIGNING_SINCE }));
  }
  const verified = verifyReleaseSums(
    sumsText,
    sigLine,
    signingKeysOverride ?? RELEASE_SIGNING_KEYS
  );
  if (!verified.ok) {
    throw new Error(t('upgrade.signatureInvalid', { version, reason: verified.reason }));
  }
}
