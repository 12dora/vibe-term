import { describe, expect, test } from 'bun:test';
import { sha256Hex } from './artifacts-manifest';
import { parseSha256Sums, verifyTarballSha256 } from './upgrade-verify';

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
