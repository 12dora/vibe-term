import { describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { resolveMeshUserId } from './mesh-user-id';

function seedUser(store: UserStore, id = 'user-1'): void {
  store.create({
    id,
    username: 'alice',
    rootPublicKey: new Uint8Array(32),
    rootEpoch: 1,
    kdfParamsJson: '{}',
    keyLogHeadSeq: 0,
    keyLogHeadHash: new Uint8Array(32),
    now: 1,
  });
}

function seedCert(store: UserStore, userId: string, nodeId: string): void {
  store.upsertCert({
    nodeId,
    userId,
    admitRecordSeq: 1,
    certificateBytes: new Uint8Array(8),
    certSig: new Uint8Array(8),
    authorizationBytes: new Uint8Array(8),
    authorizationSig: new Uint8Array(8),
    revokedLogSeq: null,
  });
}

describe('resolveMeshUserId', () => {
  test('uses the only user when present', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      store.create({
        id: 'user-1',
        username: 'alice',
        rootPublicKey: new Uint8Array(32),
        rootEpoch: 1,
        kdfParamsJson: '{}',
        keyLogHeadSeq: 0,
        keyLogHeadHash: new Uint8Array(32),
        now: 1,
      });
      expect(resolveMeshUserId(store)).toBe('user-1');
      expect(resolveMeshUserId(store, { explicit: 'user-1' })).toBe('user-1');
    } finally {
      close();
    }
  });

  test('prefers explicit then cert then unique node row', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store, 'user-1');
      store.create({
        id: 'user-2',
        username: 'bob',
        rootPublicKey: new Uint8Array(32).fill(2),
        rootEpoch: 1,
        kdfParamsJson: '{}',
        keyLogHeadSeq: 0,
        keyLogHeadHash: new Uint8Array(32),
        now: 1,
      });
      expect(resolveMeshUserId(store)).toBeNull();
      expect(resolveMeshUserId(store, { explicit: 'user-2' })).toBe('user-2');
      const nodeId = 'aa'.repeat(16);
      seedCert(store, 'user-1', nodeId);
      expect(resolveMeshUserId(store, { nodeId })).toBe('user-1');
      const nodeOnly = 'bb'.repeat(16);
      store.createNode({
        id: nodeOnly,
        userId: 'user-2',
        name: 'node-only',
        now: 1,
      });
      expect(resolveMeshUserId(store, { nodeId: nodeOnly })).toBe('user-2');
    } finally {
      close();
    }
  });
});
