import { describe, expect, test } from 'bun:test';
import {
  KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
  MIN_READMIT_NODE_RECORD_VERSION,
  buildKeyLogRecord,
  encodeAdmitNodePayload,
  encodeKeyLogRecord,
  genesisHead,
} from '@tmex/shared/auth';
import { inspectHubAuthRecordCompat } from '../hub/hub-authorization';
import { createMigratedAuthDb } from './test-db';
import { UserStore } from './user-store';

const SELF = 'aa'.repeat(16);
const PEER = 'bb'.repeat(16);

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

function readmitRecord(): Uint8Array {
  return encodeKeyLogRecord(
    buildKeyLogRecord(genesisHead(), 0, {
      uid: 'user-1',
      type: 'readmit-node',
      payload: encodeAdmitNodePayload({
        authorization_bytes: new Uint8Array(4),
        authorization_sig: new Uint8Array(64),
        certificate_bytes: new Uint8Array(4),
        cert_sig: new Uint8Array(64),
      }),
      signer: 'root',
      credential_id: null,
    })
  );
}

describe('readmit-node 版本门禁', () => {
  test('旧节点被 minVersion 1.1.26 拦截且不允许 force', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      store.createNode({
        id: PEER,
        userId: 'user-1',
        name: 'old',
        version: '1.1.24',
        now: 1,
      });
      seedCert(store, 'user-1', PEER);
      const blocked = inspectHubAuthRecordCompat(store, readmitRecord(), 'user-1');
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.code).toBe(KEYLOG_TYPE_UNSUPPORTED_BY_NODES);
        expect(blocked.minVersion).toBe(MIN_READMIT_NODE_RECORD_VERSION);
        expect(blocked.allowForce).toBe(false);
        expect(blocked.nodes).toEqual([{ id: PEER, name: 'old', version: '1.1.24' }]);
      }
    } finally {
      close();
    }
  });

  test('全部节点达到 1.1.26 时放行', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      store.createNode({
        id: SELF,
        userId: 'user-1',
        name: 'writer',
        version: '1.1.26',
        now: 1,
      });
      seedCert(store, 'user-1', SELF);
      expect(inspectHubAuthRecordCompat(store, readmitRecord(), 'user-1')).toEqual({ ok: true });
    } finally {
      close();
    }
  });
});
