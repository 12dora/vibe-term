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
  test('rejects a joined url that is not in the root-signed set-relays list', () => {
    const token = randomBytes(32);
    try {
      relaysForPersist(
        [{ url: 'https://b.example', tenantId: 'bb'.repeat(16), token, priority: 3 }],
        { url: 'https://a.example', tenantId: 'aa'.repeat(16), token }
      );
      throw new Error('expected relaysForPersist to throw');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'RelayPasswordJoinError',
        code: 'join_failed',
        message: '该中继不在根签名的中继列表里',
      });
    }
  });

  test('replaces the token of the matching row and reindexes priorities', () => {
    const oldToken = randomBytes(32);
    const joinedToken = randomBytes(32);
    const rows = relaysForPersist(
      [
        { url: 'https://a.example', tenantId: 'aa'.repeat(16), token: oldToken, priority: 2 },
        { url: 'https://b.example', tenantId: 'bb'.repeat(16), token: oldToken, priority: 5 },
      ],
      { url: 'https://a.example', tenantId: 'aa'.repeat(16), token: joinedToken }
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.url).toBe('https://a.example');
    expect(rows[0]?.token).toBe(joinedToken);
    expect(rows[0]?.priority).toBe(0);
    expect(rows[1]?.token).toBe(oldToken);
  });
});
