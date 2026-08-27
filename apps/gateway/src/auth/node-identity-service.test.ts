import { describe, expect, test } from 'bun:test';
import {
  applyKeyLogRecord,
  buildKeyLogRecord,
  bytesEqual,
  decodeAuthorization,
  emptyUserKeyState,
  encodeAdmitNodePayload,
  encodeKeyLogRecord,
  encodePasskeyAssertion,
  signKeyLogRecordWithRoot,
  verifyKeyLogRecord,
} from '@tmex/shared/auth';
import { KeyLogStore } from './key-log-store';
import { ensureNodeIdentity, selfSignedNodeCertificate } from './node-identity-service';
import { NodeIdentityStore } from './node-identity-store';
import { NodeSessionStore } from './node-session-store';
import { createMigratedAuthDb } from './test-db';
import { UserKeyService } from './user-key-service';
import { UserStore } from './user-store';

describe('node-identity-service', () => {
  test('ensureNodeIdentity is stable across loads', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new NodeIdentityStore(db);
      const first = await ensureNodeIdentity(store, { hubUrl: 'https://hub.example' });
      expect(first.nodeId.length).toBe(16);
      expect(first.edPrivateKey.length).toBe(32);
      expect(first.edPublicKey.length).toBe(32);
      expect(first.x25519PrivateKey.length).toBe(32);
      expect(first.x25519PublicKey.length).toBe(32);
      expect(first.hubUrl).toBe('https://hub.example');

      const second = await ensureNodeIdentity(store, { hubUrl: 'https://other' });
      expect(second.nodeIdHex).toBe(first.nodeIdHex);
      expect(bytesEqual(second.edPrivateKey, first.edPrivateKey)).toBe(true);
      expect(bytesEqual(second.x25519PrivateKey, first.x25519PrivateKey)).toBe(true);
      expect(bytesEqual(second.edPublicKey, first.edPublicKey)).toBe(true);
      expect(bytesEqual(second.x25519PublicKey, first.x25519PublicKey)).toBe(true);
      expect(second.hubUrl).toBe('https://hub.example');
    } finally {
      close();
    }
  });

  test('self-signed certificate verifies through applyKeyLogRecord', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      const keyLogStore = new KeyLogStore(db);
      const nodeSessionStore = new NodeSessionStore(db);
      const service = new UserKeyService({ db, userStore, keyLogStore, nodeSessionStore });
      const boot = await service.bootstrapUser({ username: 'hub', password: 'pw' });
      const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
      const admit = await selfSignedNodeCertificate(identity, boot.rootKey, {
        uid: boot.userId,
        rootEpoch: boot.rootEpoch,
        now: Date.now(),
      });

      const state = emptyUserKeyState(boot.rootPublicKey, undefined, boot.rootEpoch);
      state.head = service.currentState(boot.userId).head;
      const record = buildKeyLogRecord(state.head, state.rootEpoch, {
        uid: boot.userId,
        type: 'admit-node',
        payload: encodeAdmitNodePayload(admit),
        signer: 'root',
        credential_id: null,
      });
      const bytes = encodeKeyLogRecord(record);
      const sig = signKeyLogRecordWithRoot(boot.rootKey, bytes);
      const verified = await verifyKeyLogRecord(bytes, sig, {
        head: state.head,
        rootEpoch: state.rootEpoch,
        rootPublicKey: state.rootPublicKey,
        resolvePasskey: () => null,
      });
      expect(verified.ok).toBe(true);
      if (!verified.ok) {
        throw new Error(verified.error);
      }
      const applied = await applyKeyLogRecord(state, verified.record, verified.hash);
      expect(applied.ok).toBe(true);

      const persisted = await service.signAndApply(boot.userId, boot.rootKey, {
        type: 'admit-node',
        payload: encodeAdmitNodePayload(admit),
      });
      expect(persisted.ok).toBe(true);
      expect(userStore.getCert(identity.nodeIdHex)).not.toBeNull();
    } finally {
      close();
    }
  });

  test('selfSignedNodeCertificate passkey path carries credentialId on Authorization', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
      const assertion = encodePasskeyAssertion({
        credential_id: 'cred-1',
        client_data_json: new Uint8Array([1, 2, 3, 4]),
        authenticator_data: new Uint8Array([5, 6, 7, 8]),
        signature: new Uint8Array([9, 10, 11, 12]),
      });
      const admit = await selfSignedNodeCertificate(
        identity,
        { credentialId: 'cred-1', sign: () => assertion },
        { uid: 'user-1', rootEpoch: 1, now: 99 }
      );
      const auth = decodeAuthorization(admit.authorization_bytes);
      expect(auth.signer).toBe('passkey');
      expect(auth.credential_id).toBe('cred-1');
      expect(auth.uid).toBe('user-1');
      expect(auth.root_epoch).toBe(1);
      expect(bytesEqual(admit.authorization_sig, assertion)).toBe(true);
    } finally {
      close();
    }
  });
});
