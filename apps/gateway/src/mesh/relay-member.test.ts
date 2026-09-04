import { describe, expect, test } from 'bun:test';
import {
  buildKeyLogRecord,
  decodeBase64url,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeKeyLogRecord,
  genesisHead,
} from '@tmex/shared/auth';
import { KeyLogStore } from '../auth/key-log-store';
import { ensureNodeIdentity, selfSignedNodeCertificate } from '../auth/node-identity-service';
import { NodeIdentityStore } from '../auth/node-identity-store';
import { NodeSessionStore } from '../auth/node-session-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserKeyService } from '../auth/user-key-service';
import { UserStore } from '../auth/user-store';
import { selfAdmitMemberProof } from './relay-member';
import type { KeyLogApplier } from './types';

describe('selfAdmitMemberProof', () => {
  test('returns the admit-node sidecar from the local log when the cert row is missing', async () => {
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
      const boot = await service.bootstrapUser({ username: 'solo', password: 'pw' });
      const admit = await selfSignedNodeCertificate(identity, boot.rootKey, {
        uid: boot.userId,
        rootEpoch: boot.rootEpoch,
        now: Date.now(),
      });
      const record = buildKeyLogRecord(genesisHead(), boot.rootEpoch, {
        uid: boot.userId,
        type: 'admit-node',
        payload: encodeAdmitNodePayload(admit),
        signer: 'root',
        credential_id: null,
      });
      const bytes = encodeKeyLogRecord(record);
      const applier: KeyLogApplier = {
        head: async () => ({ seq: record.seq, hash: new Uint8Array(32) }),
        applyMany: async () => ({ applied: 0 }),
        list: async () => [{ seq: record.seq, bytes, sig: new Uint8Array(64) }],
      };
      const proof = await selfAdmitMemberProof({
        identity: { nodeId: identity.nodeIdHex, edSecretKey: identity.edPrivateKey },
        userStore,
        applier,
        userId: boot.userId,
      });
      expect(proof?.bytes).toBe(encodeBase64url(bytes));
      expect(decodeBase64url(proof?.sig ?? '').byteLength).toBe(64);
    } finally {
      close();
    }
  });
});
