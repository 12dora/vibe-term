import { describe, expect, test } from 'bun:test';
import { bytesEqual, genesisHead } from '@tmex/shared/auth';
import { KeyLogStore } from './key-log-store';
import { createMigratedAuthDb } from './test-db';
import { UserStore } from './user-store';

const HEAD_HASH = Uint8Array.from({ length: 32 }, () => 8);
const PREV = Uint8Array.from({ length: 32 }, () => 1);
const HASH = Uint8Array.from({ length: 32 }, () => 2);
const BYTES = Uint8Array.from({ length: 12 }, (_, i) => i + 3);
const SIG = Uint8Array.from({ length: 64 }, () => 9);

function seedUser(store: UserStore, id = 'user-1'): void {
  store.create({
    id,
    username: `name-${id}`,
    rootPublicKey: Uint8Array.from({ length: 32 }, () => 7),
    rootEpoch: 0,
    kdfParamsJson: '{}',
    keyLogHeadSeq: 0,
    keyLogHeadHash: HEAD_HASH,
    now: 1_000,
  });
}

describe('KeyLogStore', () => {
  test('head reads users.key_log_head_*; list / getAtSeq / append round-trip', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const users = new UserStore(db);
      const logs = new KeyLogStore(db);
      seedUser(users);
      const head = logs.head('user-1');
      expect(head).not.toBeNull();
      expect(head?.seq).toBe(0n);
      expect(bytesEqual(head?.hash ?? new Uint8Array(), HEAD_HASH)).toBe(true);
      expect(logs.head('missing')).toBeNull();

      logs.append({
        userId: 'user-1',
        seq: 1,
        prevHash: PREV,
        hash: HASH,
        rootEpoch: 0,
        type: 'reset-root',
        recordBytes: BYTES,
        sig: SIG,
        payloadJson: '{"k":1}',
        createdAt: 2_000,
      });
      users.setKeyLogHead('user-1', { seq: 1, hash: HASH, now: 2_000 });

      const listed = logs.list('user-1');
      expect(listed).toHaveLength(1);
      expect(listed[0]?.seq).toBe(1);
      expect(bytesEqual(listed[0]?.bytes ?? new Uint8Array(), BYTES)).toBe(true);
      expect(bytesEqual(listed[0]?.sig ?? new Uint8Array(), SIG)).toBe(true);
      expect(bytesEqual(listed[0]?.hash ?? new Uint8Array(), HASH)).toBe(true);

      logs.append({
        userId: 'user-1',
        seq: 2,
        prevHash: HASH,
        hash: Uint8Array.from({ length: 32 }, () => 3),
        rootEpoch: 0,
        type: 'clear-totp',
        recordBytes: Uint8Array.from([1, 2, 3]),
        sig: SIG,
        payloadJson: '{}',
        createdAt: 3_000,
      });
      expect(logs.list('user-1', 2)).toHaveLength(1);
      expect(logs.getAtSeq('user-1', 1)?.seq).toBe(1);
      expect(logs.getAtSeq('user-1', 9)).toBeNull();

      logs.deleteAll('user-1');
      expect(logs.list('user-1')).toHaveLength(0);
      expect(genesisHead().seq).toBe(0n);
    } finally {
      close();
    }
  });
});
