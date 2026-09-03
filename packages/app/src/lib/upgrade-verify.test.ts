import { describe, expect, test } from 'bun:test';
import { sha256Hex } from './artifacts-manifest';
import {
  assertReleaseIntegrity,
  parseSha256Sums,
  sha256SumsRequired,
  verifyTarballSha256,
} from './upgrade-verify';

describe('parseSha256Sums', () => {
  test('reads GNU and BSD two-space lines and ignores other files', () => {
    const text = [
      `${'a'.repeat(64)}  other.tgz`,
      `${'b'.repeat(64)}  tmex-cli-1.2.3.tgz`,
      `${'c'.repeat(64)} *tmex-cli-9.9.9.tgz`,
      '',
    ].join('\n');
    expect(parseSha256Sums(text, 'tmex-cli-1.2.3.tgz')).toBe('b'.repeat(64));
    expect(parseSha256Sums(text, 'tmex-cli-9.9.9.tgz')).toBe('c'.repeat(64));
    expect(parseSha256Sums(text, 'missing.tgz')).toBeNull();
  });
});

describe('verifyTarballSha256', () => {
  test('accepts a matching digest', () => {
    const bytes = Buffer.from('tarball-bytes');
    expect(verifyTarballSha256(bytes, sha256Hex(bytes))).toBe(true);
    expect(verifyTarballSha256(bytes, '0'.repeat(64))).toBe(false);
  });
});

describe('assertReleaseIntegrity', () => {
  const bytes = Buffer.from('tarball-bytes');
  const hex = sha256Hex(bytes);

  test('requires SHA256SUMS from 1.1.4 inclusive', () => {
    expect(sha256SumsRequired('1.1.3')).toBe(false);
    expect(sha256SumsRequired('1.1.4')).toBe(true);
    expect(sha256SumsRequired('1.2.0')).toBe(true);
  });

  test('1.1.0 allows 404 only with --allow-unverified', () => {
    expect(() =>
      assertReleaseIntegrity('1.1.0', bytes, { hex: null, missing: true, unpublished: true })
    ).toThrow(/allow-unverified|SHA256SUMS/);
    expect(() =>
      assertReleaseIntegrity(
        '1.1.0',
        bytes,
        { hex: null, missing: true, unpublished: true },
        {
          allowUnverified: true,
        }
      )
    ).not.toThrow();
  });

  test('1.1.4 404 fails even with --allow-unverified', () => {
    expect(() =>
      assertReleaseIntegrity(
        '1.1.4',
        bytes,
        { hex: null, missing: true, unpublished: true },
        {
          allowUnverified: true,
        }
      )
    ).toThrow(/1\.1\.4/);
  });

  test('200 without a matching entry fails', () => {
    expect(() =>
      assertReleaseIntegrity('1.1.0', bytes, { hex: null, missing: true, unpublished: false })
    ).toThrow(/SHA256SUMS|list/);
  });

  test('200 without a matching entry fails even with --allow-unverified', () => {
    expect(() =>
      assertReleaseIntegrity(
        '1.1.0',
        bytes,
        { hex: null, missing: true, unpublished: false },
        { allowUnverified: true }
      )
    ).toThrow(/does not list|SHA256SUMS/);
  });

  test('digest mismatch fails', () => {
    expect(() =>
      assertReleaseIntegrity('1.1.4', bytes, {
        hex: '0'.repeat(64),
        missing: false,
        unpublished: false,
      })
    ).toThrow(/mismatch|不符/);
  });

  test('matching digest passes', () => {
    expect(() =>
      assertReleaseIntegrity('1.1.4', bytes, { hex, missing: false, unpublished: false })
    ).not.toThrow();
  });
});
