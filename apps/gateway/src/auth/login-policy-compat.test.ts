import { describe, expect, test } from 'bun:test';
import {
  KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
  MIN_LOGIN_POLICY_RECORD_VERSION,
  buildLoginPolicyRecord,
  encodeKeyLogRecord,
  genesisHead,
  standardLoginPolicy,
} from '@vibeterm/shared/auth';
import { inspectKeyLogRecordCompat } from '../mesh/key-log-compat';
import { createMigratedAuthDb } from './test-db';
import { UserStore } from './user-store';

const SELF = 'aa'.repeat(16);
const PEER = 'bb'.repeat(16);
const OFFLINE = 'cc'.repeat(16);

function seedUser(store: UserStore): void {
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
}

function seedCert(store: UserStore, nodeId: string): void {
  store.upsertCert({
    nodeId,
    userId: 'user-1',
    admitRecordSeq: 1,
    certificateBytes: new Uint8Array(8),
    certSig: new Uint8Array(8),
    authorizationBytes: new Uint8Array(8),
    authorizationSig: new Uint8Array(8),
    revokedLogSeq: null,
  });
}

function policyRecord(): Uint8Array {
  return encodeKeyLogRecord(
    buildLoginPolicyRecord({
      head: genesisHead(),
      rootEpoch: 0,
      uid: 'user-1',
      policy: standardLoginPolicy(),
      signer: 'root',
    })
  );
}

describe('login-policy version gate', () => {
  test('an old node blocks the record', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      store.createNode({ id: PEER, userId: 'user-1', name: 'old', version: '2.9.0', now: 1 });
      seedCert(store, PEER);
      const blocked = inspectKeyLogRecordCompat(store, policyRecord(), 'user-1');
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.code).toBe(KEYLOG_TYPE_UNSUPPORTED_BY_NODES);
      expect(blocked.minVersion).toBe(MIN_LOGIN_POLICY_RECORD_VERSION);
      expect(blocked.nodes).toEqual([{ id: PEER, name: 'old', version: '2.9.0' }]);
    } finally {
      close();
    }
  });

  test('relay mode fail-closes an uncached member', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      seedCert(store, PEER);
      store.upsertPeer({
        nodeId: PEER,
        name: PEER,
        endpointsJson: '[]',
        inventoryJson: '{}',
        directCapable: false,
        lastSeenAt: 1,
        listVersion: 1,
        version: MIN_LOGIN_POLICY_RECORD_VERSION,
      });
      seedCert(store, OFFLINE);
      const blocked = inspectKeyLogRecordCompat(store, policyRecord(), 'user-1', {
        relayMode: true,
        localNodeId: SELF,
      });
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.nodes.map((node) => node.id)).toEqual([OFFLINE]);
    } finally {
      close();
    }
  });

  test('every peer at 2.10.0 passes and the local node is skipped', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      seedCert(store, SELF);
      seedCert(store, PEER);
      store.upsertPeer({
        nodeId: PEER,
        name: 'peer',
        endpointsJson: '[]',
        inventoryJson: '{}',
        directCapable: false,
        lastSeenAt: 1,
        listVersion: 1,
        version: '2.10.0',
      });
      expect(
        inspectKeyLogRecordCompat(store, policyRecord(), 'user-1', {
          relayMode: true,
          localNodeId: SELF,
        })
      ).toEqual({ ok: true });
    } finally {
      close();
    }
  });
});
