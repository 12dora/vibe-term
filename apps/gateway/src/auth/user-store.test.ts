import { describe, expect, test } from 'bun:test';
import { bytesEqual } from '../bytes';
import { createMigratedAuthDb } from './test-db';
import { UserStore } from './user-store';

const ROOT_PK = Uint8Array.from({ length: 32 }, () => 7);
const HEAD_HASH = Uint8Array.from({ length: 32 }, () => 8);
const CRED = Uint8Array.from({ length: 20 }, (_, i) => i);
const COSE = Uint8Array.from({ length: 64 }, (_, i) => 100 + i);
const ENROLL_PK = Uint8Array.from({ length: 32 }, () => 9);
const AUTH_SIG = Uint8Array.from({ length: 64 }, () => 3);
const CERT = Uint8Array.from({ length: 48 }, () => 4);
const CERT_SIG = Uint8Array.from({ length: 64 }, () => 5);
const AUTH_BYTES = Uint8Array.from({ length: 40 }, () => 6);

function seedUser(store: UserStore, id = 'user-1'): void {
  store.create({
    id,
    username: 'alice',
    rootPublicKey: ROOT_PK,
    rootEpoch: 0,
    kdfParamsJson: '{"kdf":"argon2id"}',
    keyLogHeadSeq: 0,
    keyLogHeadHash: HEAD_HASH,
    now: 1_000,
  });
}

describe('UserStore', () => {
  test('users CRUD: create, get, updateRoot, setKeyLogHead, setTotpRecordSeq', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      const created = store.create({
        id: 'user-1',
        username: 'alice',
        rootPublicKey: ROOT_PK,
        rootEpoch: 0,
        kdfParamsJson: '{"kdf":"argon2id"}',
        keyLogHeadSeq: 0,
        keyLogHeadHash: HEAD_HASH,
        now: 1_000,
      });
      expect(created.username).toBe('alice');
      expect(store.getByUsername('alice')?.id).toBe('user-1');
      expect(store.getById('user-1')?.createdAt).toBe(1_000);

      const nextRoot = Uint8Array.from({ length: 32 }, () => 11);
      store.updateRoot('user-1', {
        rootPublicKey: nextRoot,
        rootEpoch: 1,
        kdfParamsJson: '{"kdf":"argon2id","m":65536}',
        now: 2_000,
      });
      const nextHash = Uint8Array.from({ length: 32 }, () => 12);
      store.setKeyLogHead('user-1', { seq: 3, hash: nextHash, now: 2_000 });
      store.setTotpRecordSeq('user-1', 2, 2_000);

      const updated = store.getById('user-1');
      expect(updated?.rootEpoch).toBe(1);
      expect(updated?.kdfParamsJson).toContain('65536');
      expect(updated?.keyLogHeadSeq).toBe(3);
      expect(updated?.totpRecordSeq).toBe(2);
      expect(bytesEqual(updated?.rootPublicKey ?? new Uint8Array(), nextRoot)).toBe(true);
      expect(bytesEqual(updated?.keyLogHeadHash ?? new Uint8Array(), nextHash)).toBe(true);

      store.setTotpRecordSeq('user-1', null, 3_000);
      expect(store.getById('user-1')?.totpRecordSeq).toBeNull();
    } finally {
      close();
    }
  });

  test('user_keys insert / list / get / updateCounter / delete', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      const key = store.insertKey({
        id: 'key-1',
        userId: 'user-1',
        credentialId: CRED,
        publicKey: COSE,
        rpId: 'localhost',
        origin: 'http://localhost:19663',
        counter: 0,
        transports: ['internal'],
        name: 'Touch ID',
        logSeq: 1,
        now: 1_500,
      });
      expect(key.rpId).toBe('localhost');
      expect(store.listKeysByUser('user-1')).toHaveLength(1);
      expect(
        bytesEqual(store.getKeyByCredentialId(CRED)?.publicKey ?? new Uint8Array(), COSE)
      ).toBe(true);

      store.updateKeyCounter(CRED, 4);
      expect(store.getKeyByCredentialId(CRED)?.counter).toBe(4);

      store.deleteKey('key-1');
      expect(store.listKeysByUser('user-1')).toHaveLength(0);
      expect(store.getKeyByCredentialId(CRED)).toBeNull();
    } finally {
      close();
    }
  });

  test('node_certs upsert / get / list / markRevoked', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      store.upsertCert({
        nodeId: 'node-a',
        userId: 'user-1',
        admitRecordSeq: 1,
        certificateBytes: CERT,
        certSig: CERT_SIG,
        authorizationBytes: AUTH_BYTES,
        authorizationSig: AUTH_SIG,
      });
      expect(store.getCert('node-a')?.admitRecordSeq).toBe(1);
      store.upsertCert({
        nodeId: 'node-a',
        userId: 'user-1',
        admitRecordSeq: 2,
        certificateBytes: CERT,
        certSig: CERT_SIG,
        authorizationBytes: AUTH_BYTES,
        authorizationSig: AUTH_SIG,
      });
      expect(store.listCerts()).toHaveLength(1);
      expect(store.getCert('node-a')?.admitRecordSeq).toBe(2);
      store.markCertRevoked('node-a', 9);
      expect(store.getCert('node-a')?.revokedLogSeq).toBe(9);
    } finally {
      close();
    }
  });

  test('peer_cache list / upsert / delete', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      store.upsertPeer({
        nodeId: 'node-b',
        name: 'studio',
        endpointsJson: '[{"host":"10.0.0.2"}]',
        inventoryJson: '{"devices":[]}',
        directCapable: true,
        lastSeenAt: 10,
        listVersion: 3,
      });
      expect(store.listPeers()).toHaveLength(1);
      store.upsertPeer({
        nodeId: 'node-b',
        name: 'studio',
        endpointsJson: '[]',
        inventoryJson: '{}',
        directCapable: false,
        lastSeenAt: 20,
        listVersion: 4,
      });
      expect(store.listPeers()[0]?.listVersion).toBe(4);
      store.deletePeer('node-b');
      expect(store.listPeers()).toHaveLength(0);
    } finally {
      close();
    }
  });

  test('nodes create/get and enrollment tokens create/get/markUsed/sweepExpired', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      const node = store.createNode({
        id: 'node-a',
        userId: 'user-1',
        name: 'hub',
        now: 5_000,
      });
      expect(node.status).toBe('enrolled');
      expect(store.getNode('node-a')?.name).toBe('hub');
      expect(store.listNodes()).toHaveLength(1);

      const token = store.createEnrollmentToken({
        id: 'tok-1',
        userId: 'user-1',
        enrollPublicKey: ENROLL_PK,
        authorizationJson: '{"exp":100}',
        authorizationSig: AUTH_SIG,
        expiresAt: 100,
      });
      expect(store.getEnrollmentTokenByEnrollPublicKey(ENROLL_PK)?.id).toBe('tok-1');

      const livePk = Uint8Array.from({ length: 32 }, () => 21);
      store.createEnrollmentToken({
        id: 'tok-2',
        userId: 'user-1',
        enrollPublicKey: livePk,
        authorizationJson: '{}',
        authorizationSig: AUTH_SIG,
        expiresAt: 500,
      });
      store.markEnrollmentUsed('tok-2', { nodeId: 'node-a', now: 50 });
      expect(store.getEnrollmentTokenByEnrollPublicKey(livePk)?.usedAt).toBe(50);

      expect(store.sweepExpiredEnrollmentTokens(100)).toBe(1);
      expect(store.getEnrollmentTokenByEnrollPublicKey(ENROLL_PK)).toBeNull();
      expect(store.getEnrollmentTokenByEnrollPublicKey(livePk)?.id).toBe('tok-2');
      expect(token.usedAt).toBeNull();
    } finally {
      close();
    }
  });

  test('consumeEnrollmentToken is atomic: second consume and expired return null', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      store.createNode({
        id: 'node-a',
        userId: 'user-1',
        name: 'hub',
        now: 5_000,
      });

      const livePk = Uint8Array.from({ length: 32 }, () => 31);
      store.createEnrollmentToken({
        id: 'tok-live',
        userId: 'user-1',
        enrollPublicKey: livePk,
        authorizationJson: '{}',
        authorizationSig: AUTH_SIG,
        expiresAt: 500,
      });
      const first = store.consumeEnrollmentToken(livePk, { nodeId: 'node-a', now: 50 });
      expect(first).not.toBeNull();
      expect(first?.id).toBe('tok-live');
      expect(first?.usedAt).toBe(50);
      expect(first?.nodeId).toBe('node-a');

      const second = store.consumeEnrollmentToken(livePk, { nodeId: 'node-b', now: 60 });
      expect(second).toBeNull();
      expect(store.getEnrollmentTokenByEnrollPublicKey(livePk)?.nodeId).toBe('node-a');
      expect(store.getEnrollmentTokenByEnrollPublicKey(livePk)?.usedAt).toBe(50);

      const expiredPk = Uint8Array.from({ length: 32 }, () => 32);
      store.createEnrollmentToken({
        id: 'tok-exp',
        userId: 'user-1',
        enrollPublicKey: expiredPk,
        authorizationJson: '{}',
        authorizationSig: AUTH_SIG,
        expiresAt: 100,
      });
      expect(store.consumeEnrollmentToken(expiredPk, { nodeId: 'node-a', now: 100 })).toBeNull();
      expect(store.consumeEnrollmentToken(expiredPk, { nodeId: 'node-a', now: 101 })).toBeNull();
      expect(store.getEnrollmentTokenByEnrollPublicKey(expiredPk)?.usedAt).toBeNull();
    } finally {
      close();
    }
  });
});
