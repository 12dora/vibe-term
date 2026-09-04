import { describe, expect, test } from 'bun:test';
import { decodeKeyLogRecord } from '@tmex/shared/auth';
import { KeyLogStore } from './key-log-store';
import { ensureNodeIdentity } from './node-identity-service';
import { NodeIdentityStore } from './node-identity-store';
import { NodeSessionStore } from './node-session-store';
import { createMigratedAuthDb } from './test-db';
import { buildSelfAdmitAndMetaKey, buildSelfAdmitRecord } from './user-key-self-admit';
import { UserKeyService } from './user-key-service';
import { UserStore } from './user-store';

describe('buildSelfAdmitAndMetaKey', () => {
  test('signs admit-node then a successor meta-key for applyMany', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      const keyLogStore = new KeyLogStore(db);
      const service = new UserKeyService({
        db,
        userStore,
        keyLogStore,
        nodeSessionStore: new NodeSessionStore(db),
      });
      const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
      const boot = await service.bootstrapUser({ username: 'joiner', password: 'pw' });
      const built = await buildSelfAdmitAndMetaKey({
        service,
        userId: boot.userId,
        identity,
        rootKey: boot.rootKey,
      });
      expect(built.records).toHaveLength(2);
      expect(decodeKeyLogRecord(built.records[0]?.bytes ?? new Uint8Array()).type).toBe(
        'admit-node'
      );
      expect(decodeKeyLogRecord(built.records[1]?.bytes ?? new Uint8Array()).type).toBe('meta-key');
      const applied = await service.applyMany(boot.userId, built.records);
      expect(applied.ok).toBe(true);
      const state = service.currentState(boot.userId);
      expect(state.metaKeyEpoch).toBe(built.metaEpoch);
      expect(state.nodeCerts.has(identity.nodeIdHex)).toBe(true);
      expect(built.metaKey.byteLength).toBe(32);
    } finally {
      close();
    }
  });

  test('buildSelfAdmitRecord signs only admit-node', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      const keyLogStore = new KeyLogStore(db);
      const service = new UserKeyService({
        db,
        userStore,
        keyLogStore,
        nodeSessionStore: new NodeSessionStore(db),
      });
      const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
      const boot = await service.bootstrapUser({ username: 'joiner', password: 'pw' });
      const admit = await buildSelfAdmitRecord({
        service,
        userId: boot.userId,
        identity,
        rootKey: boot.rootKey,
      });
      expect(decodeKeyLogRecord(admit.bytes).type).toBe('admit-node');
      const applied = await service.apply(boot.userId, admit);
      expect(applied.ok).toBe(true);
      expect(service.currentState(boot.userId).nodeCerts.has(identity.nodeIdHex)).toBe(true);
    } finally {
      close();
    }
  });
});
