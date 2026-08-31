import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { releaseTarballName } from '../../../shared/src/release/source';
import { t } from '../i18n';
import { sha256Hex } from './artifacts-manifest';
import { compareSemver } from './semver';

const SUM_LINE = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/;

export const SHA256SUMS_REQUIRED_SINCE = '1.1.4';

export function sha256SumsRequired(version: string): boolean {
  return compareSemver(version, SHA256SUMS_REQUIRED_SINCE) >= 0;
}

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
