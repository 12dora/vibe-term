import { describe, expect, test } from 'bun:test';
import { computeRecordHash, randomBytes } from '../../../shared/src/auth';
import { RelayPasswordJoinError, pinHead, relaysForPersist } from './relay-password-join-flow';

describe('pinHead', () => {
  test('rejects a log shorter than the sealed pack head', () => {
    expect(() => pinHead([], 1n, randomBytes(32))).toThrow(RelayPasswordJoinError);
    expect(() => pinHead([], 1n, randomBytes(32))).toThrow(/shorter than the sealed pack head/);
  });

  test('rejects a record whose hash does not match head_hash', () => {
    const bytes = randomBytes(16);
    const sig = randomBytes(64);
    try {
      pinHead([{ bytes, sig }], 1n, randomBytes(32));
      throw new Error('expected pinHead to throw');
    } catch (error) {
      expect(error).toMatchObject({ name: 'RelayPasswordJoinError', code: 'head_hash_mismatch' });
    }
  });

  test('accepts the record at head_seq', () => {
    const bytes = randomBytes(16);
    const sig = randomBytes(64);
    expect(() => pinHead([{ bytes, sig }], 1n, computeRecordHash(bytes, sig))).not.toThrow();
  });
});

describe('relaysForPersist', () => {
  test('prepends the joined relay when missing and reindexes priorities', () => {
    const token = randomBytes(32);
    const rows = relaysForPersist(
      [{ url: 'https://b.example', tenantId: 'bb'.repeat(16), token, priority: 3 }],
      { url: 'https://a.example', tenantId: 'aa'.repeat(16), token }
    );
    expect(rows.map((row) => row.url)).toEqual(['https://a.example', 'https://b.example']);
    expect(rows.map((row) => row.priority)).toEqual([0, 1]);
  });

  test('does not duplicate an already listed url', () => {
    const token = randomBytes(32);
    const rows = relaysForPersist(
      [{ url: 'https://a.example', tenantId: 'aa'.repeat(16), token, priority: 2 }],
      { url: 'https://a.example', tenantId: 'aa'.repeat(16), token }
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.priority).toBe(0);
  });
});
