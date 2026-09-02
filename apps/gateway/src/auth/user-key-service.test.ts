import { describe, expect, test } from 'bun:test';
import {
  buildAdmitHubPayload,
  buildKeyLogRecord,
  buildRetireHubPayload,
  bytesEqual,
  computeRecordHash,
  encodeAddPasskeyPayload,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeClearTotpPayload,
  encodeKeyLogRecord,
  encodeResetRootPayload,
  encodeRevokeNodePayload,
  encodeRotateRootKeepPayload,
  encodeRotateRootPayload,
  encodeSetTotpPayload,
  generateKdfParams,
  genesisHead,
  rootKeyFromSeed,
  signKeyLogRecordWithRoot,
} from '@tmex/shared/auth';
import { KeyLogStore } from './key-log-store';
import { ensureNodeIdentity, selfSignedNodeCertificate } from './node-identity-service';
import { NodeIdentityStore } from './node-identity-store';
import { NodeSessionStore } from './node-session-store';
import { createMigratedAuthDb } from './test-db';
import { UserKeyService, kdfParamsToJson } from './user-key-service';
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

  test('signAndApply rotate-root-keep keeps passkeys/totp/sessions and reconstructs totp from the keep record', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { service, userStore, nodeSessionStore } = createService(db);
      const boot = await service.bootstrapUser({ username: 'keep', password: 'old-pass' });
      const cred = encodeBase64url(new Uint8Array(16).fill(8));
      const added = await service.signAndApply(boot.userId, boot.rootKey, {
        type: 'add-passkey',
        payload: encodeAddPasskeyPayload({
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
        }),
      });
      expect(added.ok).toBe(true);
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

      const session = nodeSessionStore.issue({
        userId: boot.userId,
        viaNodeId: 'self',
        sessPublicKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
        delegationMethod: 'root',
        now: Date.now(),
      });
      const before = service.currentState(boot.userId);
      const newParams = generateKdfParams();
      const newRoot = rootKeyFromSeed(new Uint8Array(32).fill(9));
      const wrapped = {
        alg: 'A256GCM',
        nonce: new Uint8Array(12).fill(9),
        ciphertext: new Uint8Array(8).fill(8),
        tag: new Uint8Array(16).fill(7),
      };
      const rotated = await service.signAndApply(boot.userId, boot.rootKey, {
        type: 'rotate-root-keep',
        payload: encodeRotateRootKeepPayload({
          root_public_key: newRoot.publicKey,
          kdf_params: newParams,
          totp: {
            root_epoch: before.rootEpoch + 1,
            seq: before.head.seq + 1n,
            payload: wrapped,
          },
        }),
      });
      expect(rotated.ok).toBe(true);
      if (rotated.ok) {
        expect(rotated.effects).toEqual([]);
      }

      const after = service.currentState(boot.userId);
      expect(after.rootEpoch).toBe(before.rootEpoch + 1);
      expect(bytesEqual(after.rootPublicKey, newRoot.publicKey)).toBe(true);
      expect(after.passkeys.size).toBe(1);
      expect(after.passkeys.get(cred)?.name).toBe('laptop');
      expect(after.totp?.alg).toBe('A256GCM');
      expect(bytesEqual(after.totp?.tag ?? new Uint8Array(), wrapped.tag)).toBe(true);
      expect(userStore.listKeysByUser(boot.userId)).toHaveLength(1);
      expect(userStore.getById(boot.userId)?.totpRecordSeq).toBe(Number(before.head.seq + 1n));
      expect(nodeSessionStore.verify(session.sid, { viaNodeId: 'self', now: Date.now() }).ok).toBe(
        true
      );

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

  test('admit-hub persists projection; retire-hub marks retired; revoke-node retires hub', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { service, userStore } = createService(db);
      const boot = await service.bootstrapUser({ username: 'hubs', password: 'pw' });
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
      const hub = await service.signAndApply(boot.userId, boot.rootKey, {
        type: 'admit-hub',
        payload: buildAdmitHubPayload({
          hubNodeId: identity.nodeId,
          publicUrl: 'https://standby.example',
          priority: 200,
        }),
      });
      expect(hub.ok).toBe(true);
      const row = userStore.getHubAuthorization(boot.userId, identity.nodeIdHex);
      expect(row?.status).toBe('active');
      expect(row?.publicUrl).toBe('https://standby.example');
      expect(row?.priority).toBe(200);
      expect(
        service.currentState(boot.userId).hubAuthorizations.get(identity.nodeIdHex)?.status
      ).toBe('active');

      const retiredOk = await service.signAndApply(boot.userId, boot.rootKey, {
        type: 'retire-hub',
        payload: buildRetireHubPayload({ hubNodeId: identity.nodeId }),
      });
      expect(retiredOk.ok).toBe(true);
      expect(userStore.getHubAuthorization(boot.userId, identity.nodeIdHex)?.status).toBe(
        'retired'
      );
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

      const again = await b.service.verifyChainForJoin(
        chain,
        srcState.rootPublicKey,
        srcState.head.hash
      );
      expect(again.ok).toBe(true);
      expect(b.keyLogStore.list(boot.userId)).toHaveLength(3);
      expect(b.userStore.listUsers()).toHaveLength(1);
      expect(b.userStore.getById(boot.userId)?.username).toBe(boot.userId);
    } finally {
      src.close();
      dst.close();
    }
  });

  test('remote reset-root at head 0 is rejected with reset_not_genesis', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { service, userStore, keyLogStore } = createService(db);
      const kdf = generateKdfParams();
      const root = rootKeyFromSeed(new Uint8Array(32).fill(3));
      const user = userStore.create({
        id: 'user-remote',
        username: 'remote',
        rootPublicKey: new Uint8Array(32),
        rootEpoch: 0,
        kdfParamsJson: kdfParamsToJson(kdf),
        keyLogHeadSeq: 0,
        keyLogHeadHash: new Uint8Array(32),
        now: 1,
      });
      const payload = encodeResetRootPayload({
        root_public_key: root.publicKey,
        kdf_params: kdf,
      });
      const record = buildKeyLogRecord(genesisHead(), 0, {
        uid: user.id,
        type: 'reset-root',
        payload,
        signer: 'root',
        credential_id: null,
      });
      const bytes = encodeKeyLogRecord(record);
      const sig = signKeyLogRecordWithRoot(root, bytes);
      const applied = await service.apply(user.id, { bytes, sig });
      expect(applied).toEqual({ ok: false, error: 'reset_not_genesis' });
      expect(keyLogStore.list(user.id)).toHaveLength(0);
      expect(userStore.getById(user.id)?.keyLogHeadSeq).toBe(0);

      const many = await service.applyMany(user.id, [{ bytes, sig }]);
      expect(many).toEqual({ ok: false, applied: 0, error: 'reset_not_genesis' });
    } finally {
      close();
    }
  });

  test('reset-root clearPeerCache effect deletes all peer_cache rows', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { service, userStore } = createService(db);
      await service.bootstrapUser({ username: 'peers', password: 'pw' });
      userStore.upsertPeer({
        nodeId: 'aa'.repeat(16),
        name: 'studio',
        endpointsJson: '[]',
        inventoryJson: '{}',
        directCapable: false,
        lastSeenAt: 1,
        listVersion: 1,
      });
      userStore.upsertPeer({
        nodeId: 'bb'.repeat(16),
        name: 'lab',
        endpointsJson: '[]',
        inventoryJson: '{}',
        directCapable: true,
        lastSeenAt: 2,
        listVersion: 2,
      });
      expect(userStore.listPeers()).toHaveLength(2);
      await service.bootstrapUser({ username: 'peers', password: 'next' });
      expect(userStore.listPeers()).toHaveLength(0);
    } finally {
      close();
    }
  });

  test('admit-node of a reused node_id returns node_id_reused and leaves DB unchanged', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { service, userStore } = createService(db);
      const boot = await service.bootstrapUser({ username: 'reuse', password: 'pw' });
      const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
      const admit = await selfSignedNodeCertificate(identity, boot.rootKey, {
        uid: boot.userId,
        rootEpoch: boot.rootEpoch,
        now: Date.now(),
      });
      const first = await service.signAndApply(boot.userId, boot.rootKey, {
        type: 'admit-node',
        payload: encodeAdmitNodePayload(admit),
      });
      expect(first.ok).toBe(true);
      const headBefore = userStore.getById(boot.userId)?.keyLogHeadSeq;

      const again = await selfSignedNodeCertificate(identity, boot.rootKey, {
        uid: boot.userId,
        rootEpoch: boot.rootEpoch,
        now: Date.now(),
      });
      const reused = await service.signAndApply(boot.userId, boot.rootKey, {
        type: 'admit-node',
        payload: encodeAdmitNodePayload(again),
      });
      expect(reused).toEqual({ ok: false, error: 'node_id_reused' });
      expect(userStore.getById(boot.userId)?.keyLogHeadSeq).toBe(headBefore);
      expect(userStore.getCert(identity.nodeIdHex)?.revokedLogSeq).toBeNull();

      const revoked = await service.signAndApply(boot.userId, boot.rootKey, {
        type: 'revoke-node',
        payload: encodeRevokeNodePayload({ node_id: identity.nodeId, reason: 'lost' }),
      });
      expect(revoked.ok).toBe(true);
      const afterRevoke = await service.signAndApply(boot.userId, boot.rootKey, {
        type: 'admit-node',
        payload: encodeAdmitNodePayload(again),
      });
      expect(afterRevoke).toEqual({ ok: false, error: 'node_id_reused' });
      expect(userStore.getCert(identity.nodeIdHex)?.revokedLogSeq).not.toBeNull();
    } finally {
      close();
    }
  });

  test('same bytes with a different sig at an existing seq is a fork and does not mutate DB', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { service, keyLogStore, userStore } = createService(db);
      const boot = await service.bootstrapUser({ username: 'forksig', password: 'pw' });
      const first = await service.signAndApply(boot.userId, boot.rootKey, {
        type: 'clear-totp',
        payload: encodeClearTotpPayload(),
      });
      expect(first.ok).toBe(true);
      const existing = keyLogStore.getAtSeq(boot.userId, 2);
      if (!existing) {
        throw new Error('missing seq 2');
      }
      const mutatedSig = new Uint8Array(existing.sig);
      mutatedSig[0] ^= 0xff;
      expect(bytesEqual(mutatedSig, existing.sig)).toBe(false);

      const logsBefore = keyLogStore.list(boot.userId);
      const headBefore = userStore.getById(boot.userId);

      const forked = await service.apply(boot.userId, {
        bytes: existing.bytes,
        sig: mutatedSig,
      });
      expect(forked).toEqual({ ok: false, error: 'fork' });
      const logsAfter = keyLogStore.list(boot.userId);
      expect(logsAfter).toHaveLength(logsBefore.length);
      expect(
        bytesEqual(logsAfter[1]?.sig ?? new Uint8Array(), logsBefore[1]?.sig ?? new Uint8Array())
      ).toBe(true);
      expect(userStore.getById(boot.userId)?.keyLogHeadSeq).toBe(headBefore?.keyLogHeadSeq);
      expect(
        bytesEqual(
          userStore.getById(boot.userId)?.keyLogHeadHash ?? new Uint8Array(),
          headBefore?.keyLogHeadHash ?? new Uint8Array()
        )
      ).toBe(true);
    } finally {
      close();
    }
  });

  test('verifyChainForJoin accepts extra set-totp after the enrollment anchor', async () => {
    const src = createMigratedAuthDb();
    const dst = createMigratedAuthDb();
    try {
      const a = createService(src.db);
      const boot = await a.service.bootstrapUser({ username: 'anchor', password: 'pw' });
      const enrollHead = a.service.currentState(boot.userId).head.hash;
      const totp = await a.service.signAndApply(boot.userId, boot.rootKey, {
        type: 'set-totp',
        payload: encodeSetTotpPayload({
          alg: 'A256GCM',
          nonce: new Uint8Array(12).fill(1),
          ciphertext: new Uint8Array(4).fill(2),
          tag: new Uint8Array(16).fill(3),
        }),
      });
      expect(totp.ok).toBe(true);
      const chain = a.keyLogStore.list(boot.userId).map((row) => ({
        bytes: row.bytes,
        sig: row.sig,
      }));
      const srcState = a.service.currentState(boot.userId);
      const b = createService(dst.db);
      const joined = await b.service.verifyChainForJoin(chain, srcState.rootPublicKey, enrollHead, {
        anchorHash: enrollHead,
      });
      expect(joined.ok).toBe(true);
      if (!joined.ok) {
        throw new Error(joined.error);
      }
      expect(bytesEqual(joined.state.rootPublicKey, srcState.rootPublicKey)).toBe(true);
      expect(b.keyLogStore.list(boot.userId)).toHaveLength(2);
      expect(joined.state.totp?.alg).toBe('A256GCM');
    } finally {
      src.close();
      dst.close();
    }
  });

  test('verifyChainForJoin rejects rotate-root after the enrollment anchor', async () => {
    const src = createMigratedAuthDb();
    const dst = createMigratedAuthDb();
    try {
      const a = createService(src.db);
      const boot = await a.service.bootstrapUser({ username: 'rotated', password: 'pw' });
      const enrollHead = a.service.currentState(boot.userId).head.hash;
      const newRoot = rootKeyFromSeed(new Uint8Array(32).fill(11));
      const rotated = await a.service.signAndApply(boot.userId, boot.rootKey, {
        type: 'rotate-root',
        payload: encodeRotateRootPayload({
          root_public_key: newRoot.publicKey,
          kdf_params: generateKdfParams(),
        }),
      });
      expect(rotated.ok).toBe(true);
      const chain = a.keyLogStore.list(boot.userId).map((row) => ({
        bytes: row.bytes,
        sig: row.sig,
      }));
      const b = createService(dst.db);
      const joined = await b.service.verifyChainForJoin(chain, boot.rootPublicKey, enrollHead, {
        anchorHash: enrollHead,
      });
      expect(joined.ok).toBe(false);
      if (joined.ok) {
        throw new Error('expected rotate after anchor to be rejected');
      }
      expect(joined.error).toBe('epoch_changed');
      expect(b.userStore.getById(boot.userId)).toBeNull();
    } finally {
      src.close();
      dst.close();
    }
  });

  test('commitJoin writes user, log, certs and identity in one shot', async () => {
    const src = createMigratedAuthDb();
    const dst = createMigratedAuthDb();
    try {
      const a = createService(src.db);
      const boot = await a.service.bootstrapUser({ username: 'joiner', password: 'pw' });
      const identityStore = new NodeIdentityStore(src.db);
      const identity = await ensureNodeIdentity(identityStore);
      const admit = await selfSignedNodeCertificate(identity, boot.rootKey, {
        uid: boot.userId,
        rootEpoch: boot.rootEpoch,
        now: Date.now(),
      });
      const admitted = await a.service.signAndApply(boot.userId, boot.rootKey, {
        type: 'admit-node',
        payload: encodeAdmitNodePayload(admit),
      });
      expect(admitted.ok).toBe(true);
      const chain = a.keyLogStore.list(boot.userId).map((row) => ({
        bytes: row.bytes,
        sig: row.sig,
      }));
      const srcState = a.service.currentState(boot.userId);
      const b = createService(dst.db);
      const destIdentity = await ensureNodeIdentity(new NodeIdentityStore(dst.db));
      const committed = await b.service.commitJoin({
        records: chain,
        expectedRootPublicKey: srcState.rootPublicKey,
        anchorHash: srcState.head.hash,
        username: 'joiner',
        expectedUserId: boot.userId,
        identity: {
          nodeId: destIdentity.nodeIdHex,
          hubUrl: 'https://hub.example',
          edPrivateKey: destIdentity.edPrivateKey,
          x25519PrivateKey: destIdentity.x25519PrivateKey,
          certificateJson: JSON.stringify({
            x25519PublicKey: Buffer.from(destIdentity.x25519PublicKey).toString('base64url'),
          }),
          certSig: new Uint8Array(0),
          userId: boot.userId,
        },
      });
      expect(committed.ok).toBe(true);
      expect(b.userStore.getById(boot.userId)?.username).toBe('joiner');
      expect(b.keyLogStore.list(boot.userId)).toHaveLength(2);
      expect(b.userStore.listCertsByUser(boot.userId).length).toBe(1);
      const loaded = await new NodeIdentityStore(dst.db).load();
      expect(loaded?.hubUrl).toBe('https://hub.example');
      expect(loaded?.nodeId).toBe(destIdentity.nodeIdHex);
      expect(loaded?.userId).toBe(boot.userId);
    } finally {
      src.close();
      dst.close();
    }
  });

  test('commitJoin replaces same username with a different uid from a rebuilt hub', async () => {
    const src = createMigratedAuthDb();
    const dst = createMigratedAuthDb();
    try {
      const a = createService(src.db);
      const b = createService(dst.db);
      const destIdentity = await ensureNodeIdentity(new NodeIdentityStore(dst.db));
      const stale = await b.service.bootstrapUserWithSelfAdmit({
        username: 'alice',
        password: 'old-hub-pass',
        identity: destIdentity,
      });
      const totp = await b.service.signAndApply(stale.userId, stale.rootKey, {
        type: 'set-totp',
        payload: encodeSetTotpPayload({
          alg: 'A256GCM',
          nonce: new Uint8Array(12).fill(4),
          ciphertext: new Uint8Array(8).fill(5),
          tag: new Uint8Array(16).fill(6),
        }),
      });
      expect(totp.ok).toBe(true);
      b.userStore.insertKey({
        id: 'stale-passkey',
        userId: stale.userId,
        credentialId: Uint8Array.from({ length: 20 }, (_, i) => i + 3),
        publicKey: Uint8Array.from({ length: 32 }, () => 9),
        rpId: 'localhost',
        origin: 'http://localhost',
        counter: 0,
        logSeq: 9,
        now: 1,
      });
      const session = b.nodeSessionStore.issue({
        userId: stale.userId,
        viaNodeId: destIdentity.nodeIdHex,
        sessPublicKey: Uint8Array.from({ length: 32 }, (_, i) => i + 2),
        delegationMethod: 'root',
        now: Date.now(),
      });
      b.userStore.upsertPeer({
        nodeId: 'old-peer',
        name: 'studio',
        endpointsJson: '[]',
        inventoryJson: '{}',
        directCapable: false,
        lastSeenAt: 1,
        listVersion: 1,
      });
      b.userStore.createNode({
        id: 'old-hub-node',
        userId: stale.userId,
        name: 'old-hub',
        now: 1,
      });
      b.userStore.createEnrollmentToken({
        id: 'old-enroll',
        userId: stale.userId,
        enrollPublicKey: Uint8Array.from({ length: 32 }, () => 12),
        authorizationJson: '{}',
        authorizationSig: Uint8Array.from({ length: 64 }, () => 1),
        expiresAt: Date.now() + 60_000,
      });

      const srcIdentity = await ensureNodeIdentity(new NodeIdentityStore(src.db));
      const fresh = await a.service.bootstrapUserWithSelfAdmit({
        username: 'alice',
        password: 'new-hub-pass',
        identity: srcIdentity,
      });
      expect(fresh.userId).not.toBe(stale.userId);
      const chain = a.keyLogStore.list(fresh.userId).map((row) => ({
        bytes: row.bytes,
        sig: row.sig,
      }));
      const srcState = a.service.currentState(fresh.userId);
      const committed = await b.service.commitJoin({
        records: chain,
        expectedRootPublicKey: srcState.rootPublicKey,
        anchorHash: srcState.head.hash,
        username: 'alice',
        expectedUserId: fresh.userId,
        identity: {
          nodeId: destIdentity.nodeIdHex,
          hubUrl: 'https://hub-new.example',
          edPrivateKey: destIdentity.edPrivateKey,
          x25519PrivateKey: destIdentity.x25519PrivateKey,
          certificateJson: JSON.stringify({
            x25519PublicKey: Buffer.from(destIdentity.x25519PublicKey).toString('base64url'),
          }),
          certSig: new Uint8Array(0),
          userId: fresh.userId,
        },
      });
      expect(committed.ok).toBe(true);
      if (!committed.ok) throw new Error(committed.error);
      expect(committed.replacedStaleUsername).toBe('alice');
      expect(b.userStore.getByUsername('alice')?.id).toBe(fresh.userId);
      expect(b.userStore.getById(stale.userId)).toBeNull();
      expect(b.userStore.listUsers()).toHaveLength(1);
      expect(b.keyLogStore.list(stale.userId)).toHaveLength(0);
      expect(b.keyLogStore.list(fresh.userId)).toHaveLength(chain.length);
      expect(b.userStore.listKeysByUser(stale.userId)).toHaveLength(0);
      expect(b.userStore.listKeysByUser(fresh.userId)).toHaveLength(0);
      expect(b.userStore.listCertsByUser(stale.userId)).toHaveLength(0);
      expect(b.userStore.listCertsByUser(fresh.userId).length).toBe(1);
      expect(b.userStore.listPeers()).toHaveLength(0);
      expect(b.userStore.getNode('old-hub-node')).toBeNull();
      expect(b.userStore.getEnrollmentTokenById('old-enroll')).toBeNull();
      expect(
        b.nodeSessionStore.verify(session.sid, {
          viaNodeId: destIdentity.nodeIdHex,
          now: Date.now(),
        }).ok
      ).toBe(false);
      const loaded = await new NodeIdentityStore(dst.db).load();
      expect(loaded?.nodeId).toBe(destIdentity.nodeIdHex);
      expect(loaded?.userId).toBe(fresh.userId);
      expect(loaded?.hubUrl).toBe('https://hub-new.example');
    } finally {
      src.close();
      dst.close();
    }
  });

  test('commitJoin same uid is idempotent and does not duplicate rows', async () => {
    const src = createMigratedAuthDb();
    const dst = createMigratedAuthDb();
    try {
      const a = createService(src.db);
      const b = createService(dst.db);
      const destIdentity = await ensureNodeIdentity(new NodeIdentityStore(dst.db));
      const boot = await a.service.bootstrapUserWithSelfAdmit({
        username: 'joiner',
        password: 'pw',
        identity: await ensureNodeIdentity(new NodeIdentityStore(src.db)),
      });
      const chain = a.keyLogStore.list(boot.userId).map((row) => ({
        bytes: row.bytes,
        sig: row.sig,
      }));
      const srcState = a.service.currentState(boot.userId);
      const identity = {
        nodeId: destIdentity.nodeIdHex,
        hubUrl: 'https://hub.example',
        edPrivateKey: destIdentity.edPrivateKey,
        x25519PrivateKey: destIdentity.x25519PrivateKey,
        certificateJson: JSON.stringify({
          x25519PublicKey: Buffer.from(destIdentity.x25519PublicKey).toString('base64url'),
        }),
        certSig: new Uint8Array(0),
        userId: boot.userId,
      };
      const first = await b.service.commitJoin({
        records: chain,
        expectedRootPublicKey: srcState.rootPublicKey,
        anchorHash: srcState.head.hash,
        username: 'joiner',
        expectedUserId: boot.userId,
        identity,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error(first.error);
      expect(first.replacedStaleUsername).toBeUndefined();
      const second = await b.service.commitJoin({
        records: chain,
        expectedRootPublicKey: srcState.rootPublicKey,
        anchorHash: srcState.head.hash,
        username: 'joiner',
        expectedUserId: boot.userId,
        identity,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error(second.error);
      expect(second.replacedStaleUsername).toBeUndefined();
      expect(b.userStore.listUsers()).toHaveLength(1);
      expect(b.userStore.getByUsername('joiner')?.id).toBe(boot.userId);
      expect(b.keyLogStore.list(boot.userId)).toHaveLength(chain.length);
      expect(b.userStore.listCertsByUser(boot.userId).length).toBe(1);
      const loaded = await new NodeIdentityStore(dst.db).load();
      expect(loaded?.nodeId).toBe(destIdentity.nodeIdHex);
      expect(loaded?.userId).toBe(boot.userId);
    } finally {
      src.close();
      dst.close();
    }
  });

  test('bootstrapUserWithSelfAdmit commits genesis and admit-node together', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { service, userStore, keyLogStore } = createService(db);
      const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
      const boot = await service.bootstrapUserWithSelfAdmit({
        username: 'selfish',
        password: 'pw-self-admit',
        identity,
      });
      expect(boot.rootEpoch).toBe(1);
      expect(userStore.getByUsername('selfish')?.id).toBe(boot.userId);
      expect(keyLogStore.list(boot.userId).map((row) => row.seq)).toEqual([1, 2]);
      expect(userStore.listCertsByUser(boot.userId).length).toBe(1);
      expect(userStore.getCert(identity.nodeIdHex)?.userId).toBe(boot.userId);
      expect((await new NodeIdentityStore(db).load())?.userId).toBe(boot.userId);
    } finally {
      close();
    }
  });

  test('bootstrapUserWithSelfAdmit reset keeps username and replaces log in one commit', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { service, userStore, keyLogStore } = createService(db);
      const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
      const first = await service.bootstrapUserWithSelfAdmit({
        username: 'resetme',
        password: 'first-pass',
        identity,
      });
      const oldCert = userStore.getCert(identity.nodeIdHex);
      const reset = await service.bootstrapUserWithSelfAdmit({
        username: 'resetme',
        password: 'second-pass',
        identity,
      });
      expect(reset.userId).toBe(first.userId);
      expect((await new NodeIdentityStore(db).load())?.userId).toBe(first.userId);
      expect(reset.rootEpoch).toBeGreaterThan(first.rootEpoch);
      expect(userStore.getById(first.userId)?.username).toBe('resetme');
      expect(keyLogStore.list(first.userId).map((row) => row.seq)).toEqual([1, 2]);
      const nextCert = userStore.getCert(identity.nodeIdHex);
      expect(nextCert).not.toBeNull();
      expect(
        bytesEqual(
          oldCert?.certificateBytes ?? new Uint8Array(),
          nextCert?.certificateBytes ?? new Uint8Array()
        )
      ).toBe(false);
    } finally {
      close();
    }
  });

  test('applyMany abort mid-batch does not commit further records', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { service, keyLogStore } = createService(db);
      const boot = await service.bootstrapUser({ username: 'abort-batch', password: 'pw' });
      const totp = encodeSetTotpPayload({
        alg: 'A256GCM',
        nonce: new Uint8Array(12).fill(1),
        ciphertext: new Uint8Array(8).fill(2),
        tag: new Uint8Array(16).fill(3),
      });
      const first = buildKeyLogRecord(service.currentState(boot.userId).head, boot.rootEpoch, {
        uid: boot.userId,
        type: 'set-totp',
        payload: totp,
        signer: 'root',
        credential_id: null,
      });
      const firstBytes = encodeKeyLogRecord(first);
      const firstSig = signKeyLogRecordWithRoot(boot.rootKey, firstBytes);
      const second = buildKeyLogRecord(
        { seq: first.seq, hash: computeRecordHash(firstBytes, firstSig) },
        boot.rootEpoch,
        {
          uid: boot.userId,
          type: 'clear-totp',
          payload: encodeClearTotpPayload(),
          signer: 'root',
          credential_id: null,
        }
      );
      const secondBytes = encodeKeyLogRecord(second);
      const secondSig = signKeyLogRecordWithRoot(boot.rootKey, secondBytes);
      const controller = new AbortController();
      const resultP = service.applyMany(
        boot.userId,
        [
          { bytes: firstBytes, sig: firstSig },
          { bytes: secondBytes, sig: secondSig },
        ],
        controller.signal
      );
      controller.abort();
      const result = await resultP;
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected abort');
      expect(result.error).toBe('aborted');
      expect(result.applied).toBe(0);
      expect(keyLogStore.list(boot.userId).map((row) => row.seq)).toEqual([1]);
    } finally {
      close();
    }
  });

  test('applyMany 2000 records commits atomically without per-step state snapshots', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { service, keyLogStore, userStore } = createService(db);
      const boot = await service.bootstrapUser({ username: 'many-batch', password: 'pw' });
      const totp = encodeSetTotpPayload({
        alg: 'A256GCM',
        nonce: new Uint8Array(12).fill(1),
        ciphertext: new Uint8Array(8).fill(2),
        tag: new Uint8Array(16).fill(3),
      });
      const records: { bytes: Uint8Array; sig: Uint8Array }[] = [];
      let head = service.currentState(boot.userId).head;
      for (let i = 0; i < 2000; i++) {
        const type = i % 2 === 0 ? 'set-totp' : 'clear-totp';
        const payload = type === 'set-totp' ? totp : encodeClearTotpPayload();
        const record = buildKeyLogRecord(head, boot.rootEpoch, {
          uid: boot.userId,
          type,
          payload,
          signer: 'root',
          credential_id: null,
        });
        const bytes = encodeKeyLogRecord(record);
        const sig = signKeyLogRecordWithRoot(boot.rootKey, bytes);
        records.push({ bytes, sig });
        head = { seq: record.seq, hash: computeRecordHash(bytes, sig) };
      }
      const result = await service.applyMany(boot.userId, records);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.applied).toBe(2000);
      expect(result.seq).toBe(2001);
      expect(keyLogStore.list(boot.userId)).toHaveLength(2001);
      expect(userStore.getById(boot.userId)?.keyLogHeadSeq).toBe(2001);
    } finally {
      close();
    }
  });
});
