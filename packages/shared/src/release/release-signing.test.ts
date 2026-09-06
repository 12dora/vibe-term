import { describe, expect, test } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  RELEASE_SIGNING_KEYS,
  RELEASE_SIGNING_SINCE,
  type ReleaseSigningKey,
  expectedTarballHash,
  parseSha256Sums,
  releaseSignatureRequired,
  releaseSumsFileName,
  signReleaseSums,
  verifyReleaseSums,
} from './release-signing';

function encodeBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin);
}

function testKey(id: string, seedByte: number): { seed: Uint8Array; key: ReleaseSigningKey } {
  const seed = new Uint8Array(32).fill(seedByte);
  return { seed, key: { id, publicKey: encodeBase64(ed25519.getPublicKey(seed)) } };
}

const SUMS = [
  `${'a'.repeat(64)}  vibeterm-cli-1.1.39.tgz`,
  `${'b'.repeat(64)} *dist/other.tgz`,
  '',
].join('\n');

describe('signReleaseSums / verifyReleaseSums', () => {
  test('round trip with a known key id', () => {
    const { seed, key } = testKey('t1', 7);
    const line = signReleaseSums(seed, SUMS, [key]);
    expect(line.split(' ').slice(0, 3)).toEqual(['tmex-release-sig', 'v1', 't1']);
    expect(verifyReleaseSums(SUMS, line, [key])).toEqual({ ok: true, keyId: 't1' });
  });

  test('accepts a base64 seed and a trailing newline on the signature file', () => {
    const { seed, key } = testKey('t1', 9);
    const line = signReleaseSums(encodeBase64(seed), SUMS, [key]);
    expect(verifyReleaseSums(SUMS, `${line}\n`, [key])).toEqual({ ok: true, keyId: 't1' });
  });

  test('signing refuses a seed whose public key is not listed', () => {
    const { seed } = testKey('t1', 11);
    const other = testKey('t2', 12);
    expect(() => signReleaseSums(seed, SUMS, [other.key])).toThrow(/RELEASE_SIGNING_KEYS/);
  });

  test('signing refuses a seed that is not 32 bytes', () => {
    expect(() => signReleaseSums(new Uint8Array(16), SUMS)).toThrow(/32 bytes/);
  });

  test('tampered sums fail verification', () => {
    const { seed, key } = testKey('t1', 3);
    const line = signReleaseSums(seed, SUMS, [key]);
    const tampered = SUMS.replace('a'.repeat(64), 'c'.repeat(64));
    expect(verifyReleaseSums(tampered, line, [key])).toEqual({
      ok: false,
      keyId: 't1',
      reason: 'bad_signature',
    });
  });

  test('a signature made by another key fails', () => {
    const mine = testKey('t1', 3);
    const evil = testKey('t1', 4);
    const line = signReleaseSums(evil.seed, SUMS, [evil.key]);
    expect(verifyReleaseSums(SUMS, line, [mine.key])).toEqual({
      ok: false,
      keyId: 't1',
      reason: 'bad_signature',
    });
  });

  test('unknown key id is reported separately from a bad signature', () => {
    const { seed, key } = testKey('t9', 5);
    const line = signReleaseSums(seed, SUMS, [key]);
    expect(verifyReleaseSums(SUMS, line, RELEASE_SIGNING_KEYS)).toEqual({
      ok: false,
      keyId: 't9',
      reason: 'unknown_key',
    });
  });

  test('malformed signature lines are rejected', () => {
    const { seed, key } = testKey('t1', 6);
    const line = signReleaseSums(seed, SUMS, [key]);
    const sig = line.split(' ')[3] as string;
    const malformed = [
      '',
      'garbage',
      `tmex-release-sig v2 t1 ${sig}`,
      `tmex-release-sigx v1 t1 ${sig}`,
      `tmex-release-sig v1 t1 ${sig} extra`,
      'tmex-release-sig v1 t1',
      'tmex-release-sig v1 t1 not-base64!!',
      `tmex-release-sig v1 t1 ${encodeBase64(new Uint8Array(63))}`,
    ];
    for (const value of malformed) {
      expect(verifyReleaseSums(SUMS, value, [key])).toMatchObject({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  test('signature is over the exact bytes: whitespace changes break it', () => {
    const { seed, key } = testKey('t1', 8);
    const line = signReleaseSums(seed, SUMS, [key]);
    expect(verifyReleaseSums(`${SUMS}\n`, line, [key]).ok).toBe(false);
    expect(verifyReleaseSums(SUMS.trimEnd(), line, [key]).ok).toBe(false);
  });
});

describe('parseSha256Sums / expectedTarballHash', () => {
  test('maps file names to lowercase digests, ignoring directories', () => {
    const map = parseSha256Sums(SUMS);
    expect(map.get('vibeterm-cli-1.1.39.tgz')).toBe('a'.repeat(64));
    expect(map.get('other.tgz')).toBe('b'.repeat(64));
    expect(map.size).toBe(2);
  });

  test('uppercase digests are normalized and malformed lines skipped', () => {
    const text = ['nonsense', 'short  x.tgz', `${'A'.repeat(64)}  vibeterm-cli-1.2.3.tgz`, ''].join(
      '\r\n'
    );
    expect(parseSha256Sums(text).get('vibeterm-cli-1.2.3.tgz')).toBe('a'.repeat(64));
  });

  test('trailing separators and directory prefixes resolve to the same file name', () => {
    const text = `${'a'.repeat(64)}  dist/pkg/vibeterm-cli-1.2.3.tgz\n`;
    expect(parseSha256Sums(text).get('vibeterm-cli-1.2.3.tgz')).toBe('a'.repeat(64));
    expect(releaseSumsFileName('dist/pkg/')).toBe('pkg');
    expect(releaseSumsFileName('vibeterm-cli-1.2.3.tgz')).toBe('vibeterm-cli-1.2.3.tgz');
  });

  test('duplicate file names keep the first entry', () => {
    const text = `${'a'.repeat(64)}  x.tgz\n${'b'.repeat(64)}  x.tgz\n`;
    expect(parseSha256Sums(text).get('x.tgz')).toBe('a'.repeat(64));
  });

  test('expectedTarballHash resolves by version', () => {
    // SUMS 只列了改名前的资产名，走旧名回退
    expect(expectedTarballHash(SUMS, '1.1.39')).toBe('a'.repeat(64));
    expect(expectedTarballHash(SUMS, '9.9.9')).toBeNull();
  });

  test('expectedTarballHash 优先取新资产名，缺失才回退旧名', () => {
    const both = [
      `${'c'.repeat(64)}  vibeterm-cli-2.0.0.tgz`,
      `${'d'.repeat(64)}  tmex-cli-2.0.0.tgz`,
      '',
    ].join('\n');
    expect(expectedTarballHash(both, '2.0.0')).toBe('c'.repeat(64));
    expect(expectedTarballHash(`${'d'.repeat(64)}  tmex-cli-2.0.0.tgz\n`, '2.0.0')).toBe(
      'd'.repeat(64)
    );
  });

  test('给了资产名就精确查，不做任何回退', () => {
    const both = [
      `${'c'.repeat(64)}  vibeterm-cli-2.0.0.tgz`,
      `${'d'.repeat(64)}  tmex-cli-2.0.0.tgz`,
      '',
    ].join('\n');
    expect(expectedTarballHash(both, '2.0.0', 'tmex-cli-2.0.0.tgz')).toBe('d'.repeat(64));
    expect(expectedTarballHash(both, '2.0.0', 'vibeterm-cli-2.0.0.tgz')).toBe('c'.repeat(64));
    expect(
      expectedTarballHash(
        `${'c'.repeat(64)}  vibeterm-cli-2.0.0.tgz\n`,
        '2.0.0',
        'tmex-cli-2.0.0.tgz'
      )
    ).toBeNull();
  });
});

describe('releaseSignatureRequired', () => {
  test('required from the cutover version on', () => {
    expect(releaseSignatureRequired(RELEASE_SIGNING_SINCE)).toBe(true);
    expect(releaseSignatureRequired('1.1.40')).toBe(true);
    expect(releaseSignatureRequired('2.0.0')).toBe(true);
  });

  test('older releases may be unsigned', () => {
    expect(releaseSignatureRequired('1.1.38')).toBe(false);
    expect(releaseSignatureRequired('1.0.0')).toBe(false);
  });

  test('unparsable versions fail closed', () => {
    expect(releaseSignatureRequired('1.1.38_dev')).toBe(true);
    expect(releaseSignatureRequired('')).toBe(true);
  });
});

describe('RELEASE_SIGNING_KEYS', () => {
  test('every embedded key is a raw 32-byte Ed25519 public key', () => {
    expect(RELEASE_SIGNING_KEYS.length).toBeGreaterThan(0);
    for (const key of RELEASE_SIGNING_KEYS) {
      expect(key.id).toMatch(/^[a-z0-9]+$/);
      expect(atob(key.publicKey).length).toBe(32);
    }
    const ids = RELEASE_SIGNING_KEYS.map((key) => key.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
