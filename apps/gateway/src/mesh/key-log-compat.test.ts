import { describe, expect, test } from 'bun:test';
import {
  KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
  MIN_READMIT_NODE_RECORD_VERSION,
  MIN_ROTATE_ROOT_KEEP_RECORD_VERSION,
  buildKeyLogRecord,
  encodeAdmitNodePayload,
  encodeKeyLogRecord,
  encodeRenameNodePayload,
  encodeRotateRootKeepPayload,
  generateKdfParams,
  genesisHead,
} from '@vibeterm/shared/auth';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { inspectKeyLogRecordCompat } from './key-log-compat';

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

function seedCert(
  store: UserStore,
  userId: string,
  nodeId: string,
  revokedLogSeq: number | null = null
): void {
  store.upsertCert({
    nodeId,
    userId,
    admitRecordSeq: 1,
    certificateBytes: new Uint8Array(8),
    certSig: new Uint8Array(8),
    authorizationBytes: new Uint8Array(8),
    authorizationSig: new Uint8Array(8),
    revokedLogSeq,
  });
}

function rotateRootKeepRecord(): Uint8Array {
  return encodeKeyLogRecord(
    buildKeyLogRecord(genesisHead(), 0, {
      uid: 'user-1',
      type: 'rotate-root-keep',
      payload: encodeRotateRootKeepPayload({
        root_public_key: new Uint8Array(32).fill(1),
        kdf_params: generateKdfParams(),
        totp: null,
      }),
      signer: 'root',
      credential_id: null,
    })
  );
}

function relayRecord(type: 'set-relays' | 'meta-key' | 'rename-node' | 'readmit-node'): Uint8Array {
  const payload =
    type === 'rename-node'
      ? encodeRenameNodePayload({ node_id: new Uint8Array(16).fill(1), name: 'studio' })
      : type === 'readmit-node'
        ? encodeAdmitNodePayload({
            authorization_bytes: new Uint8Array(4),
            authorization_sig: new Uint8Array(64),
            certificate_bytes: new Uint8Array(4),
            cert_sig: new Uint8Array(64),
          })
        : new Uint8Array(4);
  return encodeKeyLogRecord(
    buildKeyLogRecord(genesisHead(), 0, {
      uid: 'user-1',
      type,
      payload,
      signer: 'root',
      credential_id: null,
    })
  );
}

function seedPeer(store: UserStore, nodeId: string, name: string, version: string | null): void {
  store.upsertPeer({
    nodeId,
    name,
    endpointsJson: '[]',
    inventoryJson: '{}',
    directCapable: false,
    lastSeenAt: 1,
    listVersion: 1,
    version,
  });
}

const SELF = 'aa'.repeat(16);
const PEER = 'bb'.repeat(16);
const OTHER = 'cc'.repeat(16);

describe('key-log record compat gate', () => {
  test('types without KEYLOG_RECORD_COMPAT spec pass', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      seedCert(store, 'user-1', SELF);
      const admitNode = encodeKeyLogRecord(
        buildKeyLogRecord(genesisHead(), 0, {
          uid: 'user-1',
          type: 'admit-node',
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
      expect(inspectKeyLogRecordCompat(store, admitNode, 'user-1')).toEqual({ ok: true });
    } finally {
      close();
    }
  });

  test('blocks rotate-root-keep when a live node is old or unknown; revoked nodes do not block', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      store.createNode({
        id: SELF,
        userId: 'user-1',
        name: 'writer',
        version: '1.1.16',
        now: 1,
      });
      seedCert(store, 'user-1', SELF);
      store.createNode({
        id: PEER,
        userId: 'user-1',
        name: 'old',
        version: '1.1.15',
        now: 1,
      });
      seedCert(store, 'user-1', PEER);
      store.createNode({
        id: OTHER,
        userId: 'user-1',
        name: 'revoked-old',
        status: 'revoked',
        version: '1.0.0',
        now: 1,
      });
      seedCert(store, 'user-1', OTHER, 9);
      const record = rotateRootKeepRecord();
      const blocked = inspectKeyLogRecordCompat(store, record, 'user-1');
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.code).toBe(KEYLOG_TYPE_UNSUPPORTED_BY_NODES);
        expect(blocked.minVersion).toBe(MIN_ROTATE_ROOT_KEEP_RECORD_VERSION);
        expect(blocked.nodes).toEqual([{ id: PEER, name: 'old', version: '1.1.15' }]);
      }
    } finally {
      close();
    }
  });

  test('allows rotate-root-keep when every live node meets 1.1.16', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      store.createNode({
        id: SELF,
        userId: 'user-1',
        name: 'writer',
        version: '1.1.16_dev',
        now: 1,
      });
      seedCert(store, 'user-1', SELF);
      const record = rotateRootKeepRecord();
      expect(inspectKeyLogRecordCompat(store, record, 'user-1')).toEqual({ ok: true });
    } finally {
      close();
    }
  });

  test('中继记录在空注册表（纯节点）上放行，rotate-root-keep 仍然 fail-closed', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      seedCert(store, 'user-1', SELF);
      const relay = { relayMode: true } as const;
      expect(inspectKeyLogRecordCompat(store, relayRecord('set-relays'), 'user-1', relay)).toEqual({
        ok: true,
      });
      expect(inspectKeyLogRecordCompat(store, relayRecord('meta-key'), 'user-1', relay)).toEqual({
        ok: true,
      });
      expect(inspectKeyLogRecordCompat(store, relayRecord('rename-node'), 'user-1', relay)).toEqual(
        { ok: true }
      );
      const readmitEmpty = inspectKeyLogRecordCompat(
        store,
        relayRecord('readmit-node'),
        'user-1',
        relay
      );
      expect(readmitEmpty.ok).toBe(false);
      if (!readmitEmpty.ok) {
        expect(readmitEmpty.minVersion).toBe(MIN_READMIT_NODE_RECORD_VERSION);
        expect(readmitEmpty.nodes).toEqual([{ id: SELF, name: SELF, version: null }]);
      }
      expect(inspectKeyLogRecordCompat(store, rotateRootKeepRecord(), 'user-1', relay).ok).toBe(
        false
      );

      store.createNode({ id: PEER, userId: 'user-1', name: 'old', version: '1.1.22', now: 1 });
      seedCert(store, 'user-1', PEER);
      const blocked = inspectKeyLogRecordCompat(store, relayRecord('set-relays'), 'user-1');
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.minVersion).toBe('1.1.23');
        expect(blocked.nodes.map((n) => n.id).sort()).toEqual([PEER, SELF].sort());
      }
    } finally {
      close();
    }
  });

  test('relay mode readmit-node: empty peer cache but certs exist is blocked', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      seedCert(store, 'user-1', SELF);
      seedCert(store, 'user-1', PEER);
      const relay = { relayMode: true } as const;
      expect(inspectKeyLogRecordCompat(store, relayRecord('set-relays'), 'user-1', relay)).toEqual({
        ok: true,
      });
      const blocked = inspectKeyLogRecordCompat(
        store,
        relayRecord('readmit-node'),
        'user-1',
        relay
      );
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.code).toBe(KEYLOG_TYPE_UNSUPPORTED_BY_NODES);
        expect(blocked.minVersion).toBe(MIN_READMIT_NODE_RECORD_VERSION);
        expect(blocked.nodes.map((n) => n.id).sort()).toEqual([PEER, SELF].sort());
        expect(blocked.nodes.every((n) => n.version === null)).toBe(true);
      }
    } finally {
      close();
    }
  });

  test('relay mode readmit-node: one cached and one uncached cert is blocked', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      seedCert(store, 'user-1', SELF);
      seedCert(store, 'user-1', PEER);
      seedPeer(store, PEER, 'ok', '1.1.26');
      const relay = { relayMode: true } as const;
      expect(inspectKeyLogRecordCompat(store, relayRecord('set-relays'), 'user-1', relay)).toEqual({
        ok: true,
      });
      const blocked = inspectKeyLogRecordCompat(
        store,
        relayRecord('readmit-node'),
        'user-1',
        relay
      );
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.code).toBe(KEYLOG_TYPE_UNSUPPORTED_BY_NODES);
        expect(blocked.minVersion).toBe(MIN_READMIT_NODE_RECORD_VERSION);
        expect(blocked.nodes).toEqual([{ id: SELF, name: SELF, version: null }]);
      }

      seedPeer(store, SELF, 'self', '1.1.26');
      expect(
        inspectKeyLogRecordCompat(store, relayRecord('readmit-node'), 'user-1', relay)
      ).toEqual({ ok: true });
    } finally {
      close();
    }
  });

  test('relay keep rotation blocks an uncached member until its version is known or its cert revoked', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      seedCert(store, 'user-1', SELF);
      seedCert(store, 'user-1', PEER);
      seedCert(store, 'user-1', OTHER);
      seedPeer(store, PEER, 'current', '1.1.16');
      const relay = { relayMode: true, localNodeId: SELF } as const;
      const record = rotateRootKeepRecord();
      const blocked = inspectKeyLogRecordCompat(store, record, 'user-1', relay);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.code).toBe(KEYLOG_TYPE_UNSUPPORTED_BY_NODES);
        expect(blocked.nodes).toEqual([{ id: OTHER, name: OTHER, version: null }]);
      }
      seedPeer(store, OTHER, 'recovered', '1.1.16');
      expect(inspectKeyLogRecordCompat(store, record, 'user-1', relay)).toEqual({ ok: true });
      seedPeer(store, OTHER, 'old', '1.1.15');
      store.markCertRevoked(OTHER, 10);
      expect(inspectKeyLogRecordCompat(store, record, 'user-1', relay)).toEqual({ ok: true });
    } finally {
      close();
    }
  });

  test('relay mode blocks old or unversioned peers and allows current peers', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      seedCert(store, 'user-1', SELF);
      seedCert(store, 'user-1', PEER);
      seedPeer(store, PEER, 'old', '1.1.15');
      const relay = { relayMode: true, localNodeId: SELF } as const;
      const blocked = inspectKeyLogRecordCompat(store, rotateRootKeepRecord(), 'user-1', relay);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.minVersion).toBe(MIN_ROTATE_ROOT_KEEP_RECORD_VERSION);
        expect(blocked.nodes).toEqual([{ id: PEER, name: 'old', version: '1.1.15' }]);
      }

      seedPeer(store, PEER, 'ok', '1.1.16');
      expect(inspectKeyLogRecordCompat(store, rotateRootKeepRecord(), 'user-1', relay)).toEqual({
        ok: true,
      });
      const relaysOld = inspectKeyLogRecordCompat(
        store,
        relayRecord('set-relays'),
        'user-1',
        relay
      );
      expect(relaysOld.ok).toBe(false);
      seedPeer(store, PEER, 'ok', '1.1.23');
      expect(inspectKeyLogRecordCompat(store, relayRecord('set-relays'), 'user-1', relay)).toEqual({
        ok: true,
      });

      seedPeer(store, PEER, 'missing', null);
      const missing = inspectKeyLogRecordCompat(store, rotateRootKeepRecord(), 'user-1', relay);
      expect(missing.ok).toBe(false);
      if (!missing.ok) {
        expect(missing.nodes).toEqual([{ id: PEER, name: 'missing', version: null }]);
      }

      seedPeer(store, PEER, 'weird', 'ver-b');
      const unparseable = inspectKeyLogRecordCompat(store, rotateRootKeepRecord(), 'user-1', relay);
      expect(unparseable.ok).toBe(false);
      if (!unparseable.ok) {
        expect(unparseable.nodes).toEqual([{ id: PEER, name: 'weird', version: 'ver-b' }]);
      }
    } finally {
      close();
    }
  });

  test('cert without a nodes row blocks; revoked cert does not', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      seedCert(store, 'user-1', SELF);
      const keep = rotateRootKeepRecord();
      const blockedKeep = inspectKeyLogRecordCompat(store, keep, 'user-1');
      expect(blockedKeep.ok).toBe(false);
      if (!blockedKeep.ok) {
        expect(blockedKeep.code).toBe(KEYLOG_TYPE_UNSUPPORTED_BY_NODES);
        expect(blockedKeep.minVersion).toBe(MIN_ROTATE_ROOT_KEEP_RECORD_VERSION);
        expect(blockedKeep.nodes).toEqual([{ id: SELF, name: SELF, version: null }]);
      }

      store.markCertRevoked(SELF, 9);
      expect(inspectKeyLogRecordCompat(store, keep, 'user-1')).toEqual({ ok: true });

      store.createNode({
        id: PEER,
        userId: 'user-1',
        name: 'old-revoked-cert',
        version: '1.1.15',
        now: 1,
      });
      seedCert(store, 'user-1', PEER, 4);
      expect(inspectKeyLogRecordCompat(store, keep, 'user-1')).toEqual({ ok: true });
    } finally {
      close();
    }
  });

  test('unparseable node version on an un-revoked cert blocks', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      store.createNode({
        id: SELF,
        userId: 'user-1',
        name: 'weird',
        version: 'ver-b',
        now: 1,
      });
      seedCert(store, 'user-1', SELF);
      const blocked = inspectKeyLogRecordCompat(store, rotateRootKeepRecord(), 'user-1');
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.nodes).toEqual([{ id: SELF, name: 'weird', version: 'ver-b' }]);
      }
    } finally {
      close();
    }
  });
});
