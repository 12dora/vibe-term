import { describe, expect, test } from 'bun:test';
import {
  buildKeyLogRecord,
  bytesEqual,
  encodeAdmitNodePayload,
  encodeClearTotpPayload,
  encodeKeyLogRecord,
  encodeRevokeNodePayload,
  encodeRotateRootPayload,
  encodeSetTotpPayload,
  generateKdfParams,
  rootKeyFromSeed,
  signKeyLogRecordWithRoot,
} from '@tmex/shared/auth';
import { KeyLogStore } from './key-log-store';
import { ensureNodeIdentity, selfSignedNodeCertificate } from './node-identity-service';
import { NodeIdentityStore } from './node-identity-store';
import { NodeSessionStore } from './node-session-store';
import { createMigratedAuthDb } from './test-db';
import { UserKeyService } from './user-key-service';
import { UserStore } from './user-store';

function createService(db: ReturnType<typeof createMigratedAuthDb>['db']) {
  const userStore = new UserStore(db);
  const keyLogStore = new KeyLogStore(db);
  const nodeSessionStore = new NodeSessionStore(db);
  const service = new UserKeyService({ db, userStore, keyLogStore, nodeSessionStore });
  return { userStore, keyLogStore, nodeSessionStore, service };
}

describe('UserKeyService', () => {
  test('bootstrapUser applies genesis reset-root and matches currentState', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { service, userStore, keyLogStore } = createService(db);
      const boot = await service.bootstrapUser({ username: 'alice', password: 'tmex-test' });
      expect(boot.rootEpoch).toBe(1);
      expect(boot.rootPublicKey.length).toBe(32);
      expect(bytesEqual(boot.rootPublicKey, boot.rootKey.publicKey)).toBe(true);

      const state = service.currentState(boot.userId);
      expect(state.rootEpoch).toBe(1);
      expect(bytesEqual(state.rootPublicKey, boot.rootPublicKey)).toBe(true);
      expect(state.passkeys.size).toBe(0);
      expect(state.totp).toBeNull();
      expect(state.head.seq).toBe(1n);

      const user = userStore.getById(boot.userId);
      expect(user?.username).toBe('alice');
      expect(user?.rootEpoch).toBe(1);
      const logs = keyLogStore.list(boot.userId);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.seq).toBe(1);
    } finally {
      close();
    }
  });

  test('signAndApply rotate-root revokes sessions, clears passkeys/totp, bumps epoch, rejects old root', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { service, userStore, nodeSessionStore } = createService(db);
      const boot = await service.bootstrapUser({ username: 'bob', password: 'old-pass' });
      const totp = await service.signAndApply(boot.userId, boot.rootKey, {
        type: 'set-totp',
        payload: encodeSetTotpPayload({
          alg: 'A256GCM',
          nonce: new Uint8Array(12).fill(1),
          ciphertext: new Uint8Array(8).fill(2),
          tag: new Uint8Array(16).fill(3),
        }),
      });
      expect(totp.ok).toBe(true);
      expect(service.currentState(boot.userId).totp?.alg).toBe('A256GCM');

      const session = nodeSessionStore.issue({
        userId: boot.userId,
        viaNodeId: 'self',
        sessPublicKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
        delegationMethod: 'root',
        now: Date.now(),
      });
      expect(nodeSessionStore.verify(session.sid, { viaNodeId: 'self', now: Date.now() }).ok).toBe(
        true
      );

      const newParams = generateKdfParams();
      const newRoot = rootKeyFromSeed(new Uint8Array(32).fill(9));
      const rotated = await service.signAndApply(boot.userId, boot.rootKey, {
        type: 'rotate-root',
        payload: encodeRotateRootPayload({
          root_public_key: newRoot.publicKey,
          kdf_params: newParams,
        }),
      });
      expect(rotated.ok).toBe(true);
      if (rotated.ok) {
        expect(rotated.effects).toEqual([{ type: 'revokeAllSessions' }]);
      }

      const after = service.currentState(boot.userId);
      expect(after.rootEpoch).toBe(2);
      expect(bytesEqual(after.rootPublicKey, newRoot.publicKey)).toBe(true);
      expect(after.passkeys.size).toBe(0);
      expect(after.totp).toBeNull();
      expect(userStore.listKeysByUser(boot.userId)).toHaveLength(0);
      expect(nodeSessionStore.verify(session.sid, { viaNodeId: 'self', now: Date.now() })).toEqual({
        ok: false,
        reason: 'revoked',
      });

      const stale = await service.signAndApply(boot.userId, boot.rootKey, {
        type: 'clear-totp',
        payload: encodeClearTotpPayload(),
      });
      expect(stale).toEqual({ ok: false, error: 'bad_signature' });

      const fresh = await service.signAndApply(boot.userId, newRoot, {
        type: 'clear-totp',
        payload: encodeClearTotpPayload(),
      });
      expect(fresh.ok).toBe(true);
    } finally {
      close();
    }
  });

  test('applying a different record at an existing seq returns fork and does not mutate DB', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { service, keyLogStore, userStore } = createService(db);
      const boot = await service.bootstrapUser({ username: 'carol', password: 'pw' });
      const first = await service.signAndApply(boot.userId, boot.rootKey, {
        type: 'clear-totp',
        payload: encodeClearTotpPayload(),
      });
      expect(first.ok).toBe(true);
      const headBefore = userStore.getById(boot.userId);
      const logsBefore = keyLogStore.list(boot.userId);

      const forkPayload = encodeSetTotpPayload({
        alg: 'A256GCM',
        nonce: new Uint8Array(12).fill(4),
        ciphertext: new Uint8Array(4).fill(5),
        tag: new Uint8Array(16).fill(6),
      });
      const genesis = keyLogStore.getAtSeq(boot.userId, 1);
      if (!genesis) {
        throw new Error('missing genesis');
      }
      const forkRecord = buildKeyLogRecord({ seq: 1n, hash: genesis.hash }, 1, {
        uid: boot.userId,
        type: 'set-totp',
        payload: forkPayload,
        signer: 'root',
        credential_id: null,
      });
      const forkBytes = encodeKeyLogRecord(forkRecord);
      const appliedFork = await service.apply(boot.userId, {
        bytes: forkBytes,
        sig: signKeyLogRecordWithRoot(boot.rootKey, forkBytes),
      });
      expect(appliedFork).toEqual({ ok: false, error: 'fork' });

      const logsAfter = keyLogStore.list(boot.userId);
      expect(logsAfter).toHaveLength(logsBefore.length);
      expect(
        bytesEqual(logsAfter[1]?.hash ?? new Uint8Array(), logsBefore[1]?.hash ?? new Uint8Array())
      ).toBe(true);
      expect(userStore.getById(boot.userId)?.keyLogHeadSeq).toBe(headBefore?.keyLogHeadSeq);
      expect(userStore.getById(boot.userId)?.totpRecordSeq).toBeNull();
    } finally {
      close();
    }
  });

  test('admit-node stores cert; revoke-node marks revoked, revokeVia, deletes peer_cache', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { service, userStore, nodeSessionStore } = createService(db);
      const boot = await service.bootstrapUser({ username: 'dave', password: 'pw' });
      const identityStore = new NodeIdentityStore(db);
      const identity = await ensureNodeIdentity(identityStore, { hubUrl: 'https://hub.test' });
      const admit = await selfSignedNodeCertificate(identity, boot.rootKey, {
        uid: boot.userId,
        rootEpoch: boot.rootEpoch,
        now: Date.now(),
      });
      const admitted = await service.signAndApply(boot.userId, boot.rootKey, {
        type: 'admit-node',
        payload: encodeAdmitNodePayload(admit),
      });
      expect(admitted.ok).toBe(true);
      const nodeHex = identity.nodeIdHex;
      const cert = userStore.getCert(nodeHex);
      expect(cert).not.toBeNull();
      expect(cert?.revokedLogSeq).toBeNull();
      expect(cert?.admitRecordSeq).toBe(2);

      userStore.upsertPeer({
        nodeId: nodeHex,
        name: 'studio',
        endpointsJson: '[]',
        inventoryJson: '{}',
        directCapable: false,
        lastSeenAt: 1,
        listVersion: 1,
      });
      const viaSession = nodeSessionStore.issue({
        userId: boot.userId,
        viaNodeId: nodeHex,
        sessPublicKey: Uint8Array.from({ length: 32 }, () => 3),
        delegationMethod: 'root',
        now: Date.now(),
      });

      const revoked = await service.signAndApply(boot.userId, boot.rootKey, {
        type: 'revoke-node',
        payload: encodeRevokeNodePayload({ node_id: identity.nodeId, reason: 'lost' }),
      });
      expect(revoked.ok).toBe(true);
      if (revoked.ok) {
        expect(revoked.effects[0]?.type).toBe('revokeSessionsVia');
      }
      expect(userStore.getCert(nodeHex)?.revokedLogSeq).toBe(3);
      expect(userStore.listPeers()).toHaveLength(0);
      expect(
        nodeSessionStore.verify(viaSession.sid, { viaNodeId: nodeHex, now: Date.now() })
      ).toEqual({ ok: false, reason: 'revoked' });
    } finally {
      close();
    }
  });

  test('verifyChainForJoin persists a chain from another DB with the same head hash', async () => {
    const src = createMigratedAuthDb();
    const dst = createMigratedAuthDb();
    try {
      const a = createService(src.db);
      const boot = await a.service.bootstrapUser({ username: 'erin', password: 'pw' });
      const totp = await a.service.signAndApply(boot.userId, boot.rootKey, {
        type: 'set-totp',
        payload: encodeSetTotpPayload({
          alg: 'A256GCM',
          nonce: new Uint8Array(12).fill(7),
          ciphertext: new Uint8Array(3).fill(8),
          tag: new Uint8Array(16).fill(9),
        }),
      });
      expect(totp.ok).toBe(true);
      const cleared = await a.service.signAndApply(boot.userId, boot.rootKey, {
        type: 'clear-totp',
        payload: encodeClearTotpPayload(),
      });
      expect(cleared.ok).toBe(true);

      const chain = a.keyLogStore.list(boot.userId).map((row) => ({
        bytes: row.bytes,
        sig: row.sig,
      }));
      const srcState = a.service.currentState(boot.userId);

      const b = createService(dst.db);
      const joined = await b.service.verifyChainForJoin(
        chain,
        srcState.rootPublicKey,
        srcState.head.hash
      );
      expect(joined.ok).toBe(true);
      if (!joined.ok) {
        throw new Error(joined.error);
      }
      expect(joined.state.rootEpoch).toBe(srcState.rootEpoch);
      expect(bytesEqual(joined.state.head.hash, srcState.head.hash)).toBe(true);
      expect(bytesEqual(joined.state.rootPublicKey, srcState.rootPublicKey)).toBe(true);
      expect(b.keyLogStore.list(boot.userId)).toHaveLength(3);

      const refuse = await b.service.verifyChainForJoin(
        chain,
        srcState.rootPublicKey,
        srcState.head.hash
      );
      expect(refuse).toEqual({ ok: false, error: 'not_empty' });
    } finally {
      src.close();
      dst.close();
    }
  });
});
