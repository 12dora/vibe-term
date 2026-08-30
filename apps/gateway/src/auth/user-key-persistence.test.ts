import { describe, expect, test } from 'bun:test';
import {
  type KeyLogRecord,
  type UserKeyState,
  emptyUserKeyState,
  encodeAddPasskeyPayload,
  encodeBase64url,
  generateKdfParams,
} from '@tmex/shared/auth';
import { eq } from 'drizzle-orm';
import { nodeIdentity } from '../db/schema';
import { KeyLogStore } from './key-log-store';
import { NodeSessionStore } from './node-session-store';
import { createMigratedAuthDb } from './test-db';
import {
  type AppliedKeyLogStep,
  bindIdentityUser,
  createTxStores,
  kdfParamsToJson,
  persistApplied,
  persistEncryptedIdentity,
  wipeUserDerivedState,
} from './user-key-persistence';
import { UserStore } from './user-store';

function openStores(db: ReturnType<typeof createMigratedAuthDb>['db']) {
  return {
    userStore: new UserStore(db),
    keyLogStore: new KeyLogStore(db),
    nodeSessionStore: new NodeSessionStore(db),
  };
}

function seedUser(userStore: UserStore, id = 'user-1', now = 1_000) {
  const kdf = generateKdfParams();
  userStore.create({
    id,
    username: `${id}-name`,
    rootPublicKey: new Uint8Array(32),
    rootEpoch: 1,
    kdfParamsJson: kdfParamsToJson(kdf),
    totpRecordSeq: 3,
    keyLogHeadSeq: 0,
    keyLogHeadHash: new Uint8Array(32),
    now,
  });
  return kdf;
}

function makeStep(
  userId: string,
  type: KeyLogRecord['type'],
  opts?: {
    seq?: bigint;
    payload?: Uint8Array;
    effects?: AppliedKeyLogStep['effects'];
    next?: Partial<UserKeyState>;
  }
): AppliedKeyLogStep {
  const seq = opts?.seq ?? 4n;
  const hash = new Uint8Array(32).fill(9);
  const kdf = generateKdfParams();
  const next = emptyUserKeyState(new Uint8Array(32).fill(2), kdf, 2);
  next.head = { seq, hash };
  Object.assign(next, opts?.next);
  next.head = opts?.next?.head ?? next.head;
  return {
    input: { bytes: new Uint8Array([1, 2, 3]), sig: new Uint8Array(64).fill(4) },
    record: {
      domain: 'tmex.keylog.v1',
      uid: userId,
      seq,
      prev_hash: new Uint8Array(32),
      root_epoch: 2,
      type,
      payload: opts?.payload ?? new Uint8Array(),
      signer: 'root',
      credential_id: null,
    },
    hash,
    next,
    effects: opts?.effects ?? [],
  };
}

describe('user-key-persistence', () => {
  test('persistApplied writes log, head and add-passkey in one shot', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const stores = openStores(db);
      seedUser(stores.userStore);
      const cred = encodeBase64url(new Uint8Array(16).fill(8));
      const payload = encodeAddPasskeyPayload({
        credential_id: cred,
        public_key: new Uint8Array(32).fill(1),
        rp_id: 'example.test',
        origin: 'https://example.test',
        counter: 0,
        transports: ['internal'],
        backup_eligible: false,
        backup_state: false,
        device_type: 'singleDevice',
        name: 'laptop',
      });
      const step = makeStep('user-1', 'add-passkey', { payload });
      persistApplied(stores, 'user-1', step, 2_000);

      const logs = stores.keyLogStore.list('user-1');
      expect(logs).toHaveLength(1);
      expect(logs[0]?.seq).toBe(4);
      const user = stores.userStore.getById('user-1');
      expect(user?.keyLogHeadSeq).toBe(4);
      expect(user?.rootEpoch).toBe(2);
      expect(stores.userStore.listKeysByUser('user-1')).toHaveLength(1);
      expect(stores.userStore.getKeyByCredentialId(new Uint8Array(16).fill(8))?.name).toBe(
        'laptop'
      );
    } finally {
      close();
    }
  });

  test('persistApplied reset-root clears keys and certs; effects revoke sessions and peers', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const stores = openStores(db);
      seedUser(stores.userStore);
      stores.userStore.insertKey({
        id: crypto.randomUUID(),
        userId: 'user-1',
        credentialId: new Uint8Array(16).fill(1),
        publicKey: new Uint8Array(32).fill(2),
        rpId: 'example.test',
        origin: 'https://example.test',
        counter: 0,
        transports: [],
        name: 'old',
        logSeq: 2,
        now: 1_000,
      });
      stores.userStore.upsertCert({
        nodeId: 'aa'.repeat(16),
        userId: 'user-1',
        admitRecordSeq: 2,
        certificateBytes: new Uint8Array(8),
        certSig: new Uint8Array(8),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(8),
      });
      stores.userStore.upsertPeer({
        nodeId: 'aa'.repeat(16),
        name: 'studio',
        endpointsJson: '[]',
        inventoryJson: '{}',
        directCapable: false,
        lastSeenAt: 1,
        listVersion: 0,
      });
      const session = stores.nodeSessionStore.issue({
        userId: 'user-1',
        viaNodeId: 'self',
        sessPublicKey: new Uint8Array(32).fill(3),
        delegationMethod: 'root',
        now: 1_000,
      });
      persistApplied(
        stores,
        'user-1',
        makeStep('user-1', 'reset-root', {
          effects: [{ type: 'revokeAllSessions' }, { type: 'clearPeerCache' }],
        }),
        3_000
      );
      expect(stores.userStore.listKeysByUser('user-1')).toHaveLength(0);
      expect(stores.userStore.listCertsByUser('user-1')).toHaveLength(0);
      expect(stores.userStore.getById('user-1')?.totpRecordSeq).toBeNull();
      expect(stores.userStore.listPeers()).toHaveLength(0);
      expect(
        stores.nodeSessionStore.verify(session.sid, { viaNodeId: 'self', now: 3_000 }).ok
      ).toBe(false);
    } finally {
      close();
    }
  });

  test('createTxStores persistApplied rolls back with the outer transaction', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const proto = openStores(db);
      seedUser(proto.userStore);
      const step = makeStep('user-1', 'set-totp');
      try {
        db.transaction((tx) => {
          persistApplied(
            createTxStores(tx, proto.userStore, proto.keyLogStore, proto.nodeSessionStore),
            'user-1',
            step,
            2_000
          );
          throw new Error('rollback');
        });
      } catch (err) {
        if (!(err instanceof Error) || err.message !== 'rollback') throw err;
      }
      expect(proto.keyLogStore.list('user-1')).toHaveLength(0);
      expect(proto.userStore.getById('user-1')?.keyLogHeadSeq).toBe(0);
      expect(proto.userStore.getById('user-1')?.totpRecordSeq).toBe(3);
    } finally {
      close();
    }
  });

  test('wipeUserDerivedState removes derived rows and keeps the user', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const stores = openStores(db);
      seedUser(stores.userStore);
      persistApplied(stores, 'user-1', makeStep('user-1', 'set-totp'), 2_000);
      stores.userStore.insertKey({
        id: crypto.randomUUID(),
        userId: 'user-1',
        credentialId: new Uint8Array(16).fill(9),
        publicKey: new Uint8Array(32).fill(1),
        rpId: 'example.test',
        origin: 'https://example.test',
        counter: 0,
        logSeq: 1,
        now: 1_000,
      });
      stores.userStore.upsertCert({
        nodeId: 'bb'.repeat(16),
        userId: 'user-1',
        admitRecordSeq: 1,
        certificateBytes: new Uint8Array(4),
        certSig: new Uint8Array(4),
        authorizationBytes: new Uint8Array(4),
        authorizationSig: new Uint8Array(4),
      });
      stores.userStore.createNode({
        id: 'cc'.repeat(16),
        userId: 'user-1',
        name: 'box',
        now: 1_000,
      });
      stores.userStore.createEnrollmentToken({
        id: crypto.randomUUID(),
        userId: 'user-1',
        enrollPublicKey: new Uint8Array(32).fill(5),
        authorizationJson: '{}',
        authorizationSig: new Uint8Array(8),
        expiresAt: 9_999,
      });
      stores.nodeSessionStore.issue({
        userId: 'user-1',
        viaNodeId: 'self',
        sessPublicKey: new Uint8Array(32).fill(6),
        delegationMethod: 'root',
        now: 1_000,
      });
      wipeUserDerivedState(stores.userStore, stores.keyLogStore, stores.nodeSessionStore, 'user-1');
      expect(stores.userStore.getById('user-1')?.username).toBe('user-1-name');
      expect(stores.keyLogStore.list('user-1')).toHaveLength(0);
      expect(stores.userStore.listKeysByUser('user-1')).toHaveLength(0);
      expect(stores.userStore.listCertsByUser('user-1')).toHaveLength(0);
      expect(stores.userStore.getNode('cc'.repeat(16))).toBeNull();
      expect(
        stores.userStore.getEnrollmentTokenByEnrollPublicKey(new Uint8Array(32).fill(5))
      ).toBeNull();
    } finally {
      close();
    }
  });

  test('persistEncryptedIdentity upserts singleton row; bindIdentityUser sets userId', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      persistEncryptedIdentity(db, {
        nodeId: 'dd'.repeat(16),
        hubUrl: 'https://hub.example',
        privateKey: 'enc-ed',
        x25519PrivateKey: 'enc-x',
        certificateJson: '{}',
        certSig: new Uint8Array([7, 8]),
        userId: null,
      });
      persistEncryptedIdentity(db, {
        nodeId: 'ee'.repeat(16),
        hubUrl: null,
        privateKey: 'enc-ed-2',
        x25519PrivateKey: 'enc-x-2',
        certificateJson: '{"v":1}',
        certSig: new Uint8Array([9]),
        userId: null,
      });
      const before = db.select().from(nodeIdentity).all();
      expect(before).toHaveLength(1);
      expect(before[0]?.id).toBe(1);
      expect(before[0]?.nodeId).toBe('ee'.repeat(16));
      expect(before[0]?.userId).toBeNull();
      bindIdentityUser(db, 'user-1');
      const after = db.select().from(nodeIdentity).where(eq(nodeIdentity.id, 1)).get();
      expect(after?.userId).toBe('user-1');
      expect(after?.nodeId).toBe('ee'.repeat(16));
    } finally {
      close();
    }
  });
});
