import { releaseTarballName } from '../../../shared/src/release/source';
import { parseSha256Sums } from '../../../shared/src/release/verify';
import { compareSemver } from '../../../shared/src/semver';
import { t } from '../i18n';
import { sha256Hex } from './artifacts-manifest';

export { parseSha256Sums };

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
