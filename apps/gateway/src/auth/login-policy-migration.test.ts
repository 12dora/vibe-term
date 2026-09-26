import { describe, expect, test } from 'bun:test';
import { KeyLogStore } from './key-log-store';
import { createMigratedAuthDb } from './test-db';
import { UserStore } from './user-store';

describe('0059 login-policy key log', () => {
  test('the type check accepts login-policy', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const users = new UserStore(db);
      users.create({
        id: 'user-1',
        username: 'alice',
        rootPublicKey: new Uint8Array(32),
        rootEpoch: 1,
        kdfParamsJson: '{}',
        keyLogHeadSeq: 0,
        keyLogHeadHash: new Uint8Array(32),
        now: 1,
      });
      const log = new KeyLogStore(db);
      log.append({
        userId: 'user-1',
        seq: 1,
        prevHash: new Uint8Array(32),
        hash: new Uint8Array(32),
        rootEpoch: 1,
        type: 'login-policy',
        recordBytes: new Uint8Array([1]),
        sig: new Uint8Array([2]),
        payloadJson: '{}',
        createdAt: 1,
      });
      expect(log.getAtSeq('user-1', 1)?.seq).toBe(1);
    } finally {
      close();
    }
  });
});
