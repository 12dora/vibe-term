import { describe, expect, test } from 'bun:test';
import {
  assertReleaseChecksum,
  assertReleaseIntegrityBytes,
  parseSha256Sums,
  sha256Hex,
} from './verify';

const FILE = 'tmex-cli-1.2.3.tgz';

describe('parseSha256Sums', () => {
  test('valid: GNU two-space and BSD asterisk lines', () => {
    const text = [
      `${'a'.repeat(64)}  other.tgz`,
      `${'b'.repeat(64)}  tmex-cli-1.2.3.tgz`,
      `${'c'.repeat(64)} *tmex-cli-9.9.9.tgz`,
      '',
    ].join('\n');
    expect(parseSha256Sums(text, FILE)).toBe('b'.repeat(64));
    expect(parseSha256Sums(text, 'tmex-cli-9.9.9.tgz')).toBe('c'.repeat(64));
  });

  test('missing entry returns null', () => {
    const text = `${'a'.repeat(64)}  other.tgz\n`;
    expect(parseSha256Sums(text, FILE)).toBeNull();
  });

  test('malformed line is skipped; later valid line still matches', () => {
    const text = ['not-a-sum-line', 'short  file.tgz', `${'b'.repeat(64)}  ${FILE}`, ''].join('\n');
    expect(parseSha256Sums(text, FILE)).toBe('b'.repeat(64));
  });

  test('CRLF line endings', () => {
    const text = `${'a'.repeat(64)}  other.tgz\r\n${'b'.repeat(64)}  ${FILE}\r\n`;
    expect(parseSha256Sums(text, FILE)).toBe('b'.repeat(64));
  });

  test('hex is lowercased', () => {
    const text = `${'A'.repeat(64)}  ${FILE}\n`;
    expect(parseSha256Sums(text, FILE)).toBe('a'.repeat(64));
  });
});

describe('assertReleaseChecksum', () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const hex = sha256Hex(bytes);

  test('valid matching digest', () => {
    expect(() => assertReleaseChecksum(hex, { hex, missing: false }, FILE)).not.toThrow();
    expect(() => assertReleaseIntegrityBytes(bytes, { hex, missing: false }, FILE)).not.toThrow();
  });

  test('tampered file / digest mismatch', () => {
    expect(() => assertReleaseChecksum(hex, { hex: '0'.repeat(64), missing: false }, FILE)).toThrow(
      /sha256 mismatch/i
    );
  });

  test('missing entry (404 / no hex)', () => {
    expect(() => assertReleaseChecksum(hex, { hex: null, missing: true }, FILE)).toThrow(
      /SHA256SUMS is missing|Refusing to continue/i
    );
    expect(() => assertReleaseChecksum(hex, { hex: null, missing: false }, FILE)).toThrow(
      /SHA256SUMS is missing|Refusing to continue/i
    );
  });
});
