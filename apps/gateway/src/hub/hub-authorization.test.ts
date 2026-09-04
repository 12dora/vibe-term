import { describe, expect, test } from 'bun:test';
import {
  KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
  MIN_HUB_AUTH_RECORD_VERSION,
  MIN_ROTATE_ROOT_KEEP_RECORD_VERSION,
  buildAdmitHubPayload,
  buildKeyLogRecord,
  encodeKeyLogRecord,
  encodeRenameNodePayload,
  encodeRotateRootKeepPayload,
  generateKdfParams,
  genesisHead,
} from '@tmex/shared/auth';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import {
  hubAuthListColumn,
  hubHttpAuthorization,
  inspectHubAuthRecordCompat,
  isAuthorizedHub,
  nodeVersionSupportsHubAuthRecords,
  resolveHubAuthorization,
  resolveMeshUserId,
} from './hub-authorization';

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

function relayRecord(type: 'set-relays' | 'meta-key' | 'rename-node'): Uint8Array {
  const payload =
    type === 'rename-node'
      ? encodeRenameNodePayload({ node_id: new Uint8Array(16).fill(1), name: 'studio' })
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

function admitHubRecord(): Uint8Array {
  return encodeKeyLogRecord(
    buildKeyLogRecord(genesisHead(), 0, {
      uid: 'user-1',
      type: 'admit-hub',
      payload: buildAdmitHubPayload({ hubNodeId: new Uint8Array(16).fill(1) }),
      signer: 'root',
      credential_id: null,
    })
  );
}

const SELF = 'aa'.repeat(16);
const PEER = 'bb'.repeat(16);
const OTHER = 'cc'.repeat(16);

describe('resolveHubAuthorization merge', () => {
  test('signed active wins; signed retired overrides env and self; absent falls back', () => {
    const env = [PEER];
    expect(
      resolveHubAuthorization({
        hubNodeId: PEER,
        selfId: SELF,
        envPeers: env,
        signed: { status: 'active' },
      })
    ).toBe('signed-active');
    expect(
      isAuthorizedHub({
        hubNodeId: PEER,
        selfId: SELF,
        envPeers: env,
        signed: { status: 'active' },
      })
    ).toBe(true);

    expect(
      resolveHubAuthorization({
        hubNodeId: PEER,
        selfId: SELF,
        envPeers: env,
        signed: { status: 'retired' },
      })
    ).toBe('signed-retired');
    expect(
      isAuthorizedHub({
        hubNodeId: PEER,
        selfId: SELF,
        envPeers: env,
        signed: { status: 'retired' },
      })
    ).toBe(false);
    expect(
      isAuthorizedHub({
        hubNodeId: SELF,
        selfId: SELF,
        envPeers: env,
        signed: { status: 'retired' },
      })
    ).toBe(false);

    expect(
      resolveHubAuthorization({
        hubNodeId: SELF,
        selfId: SELF,
        envPeers: env,
        signed: null,
      })
    ).toBe('self');
    expect(
      resolveHubAuthorization({
        hubNodeId: PEER,
        selfId: SELF,
        envPeers: env,
        signed: null,
      })
    ).toBe('env');
    expect(
      resolveHubAuthorization({
        hubNodeId: OTHER,
        selfId: SELF,
        envPeers: env,
        signed: null,
      })
    ).toBe('none');
    expect(
      isAuthorizedHub({
        hubNodeId: OTHER,
        selfId: SELF,
        envPeers: env,
        signed: null,
      })
    ).toBe(false);
  });

  test('list/http projections map sources', () => {
    expect(hubAuthListColumn('signed-active')).toBe('signed');
    expect(hubAuthListColumn('signed-retired')).toBe('no');
    expect(hubAuthListColumn('env')).toBe('env');
    expect(hubAuthListColumn('self')).toBe('self');
    expect(hubAuthListColumn('none')).toBe('no');
    expect(hubHttpAuthorization('signed-active')).toBe('signed');
    expect(hubHttpAuthorization('none')).toBe('none');
  });
});

describe('hub auth record compat gate', () => {
  test('blocks admit-hub when a live node is old, unknown, or unversioned', () => {
    expect(nodeVersionSupportsHubAuthRecords('1.1.13')).toBe(true);
    expect(nodeVersionSupportsHubAuthRecords('1.1.13_dev')).toBe(true);
    expect(nodeVersionSupportsHubAuthRecords('1.1.12')).toBe(false);
    expect(nodeVersionSupportsHubAuthRecords(null)).toBe(false);
    expect(nodeVersionSupportsHubAuthRecords('ver-b')).toBe(false);

    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      store.createNode({
        id: SELF,
        userId: 'user-1',
        name: 'writer',
        version: '1.1.13',
        now: 1,
      });
      seedCert(store, 'user-1', SELF);
      store.createNode({
        id: PEER,
        userId: 'user-1',
        name: 'old',
        version: '1.1.12',
        now: 1,
      });
      seedCert(store, 'user-1', PEER);
      const record = admitHubRecord();
      const blocked = inspectHubAuthRecordCompat(store, record, 'user-1');
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.code).toBe(KEYLOG_TYPE_UNSUPPORTED_BY_NODES);
        expect(blocked.minVersion).toBe(MIN_HUB_AUTH_RECORD_VERSION);
        expect(blocked.nodes).toEqual([{ id: PEER, name: 'old', version: '1.1.12' }]);
      }

      store.createNode({
        id: OTHER,
        userId: 'user-1',
        name: 'revoked-old',
        status: 'revoked',
        version: '1.0.0',
        now: 1,
      });
      const still = inspectHubAuthRecordCompat(store, record, 'user-1');
      expect(still.ok).toBe(false);
      if (!still.ok) {
        expect(still.nodes.map((n) => n.id)).toEqual([PEER]);
      }
    } finally {
      close();
    }
  });

  test('allows admit-hub when every live node meets the min version', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      store.createNode({
        id: SELF,
        userId: 'user-1',
        name: 'writer',
        version: '1.1.13_dev',
        now: 1,
      });
      seedCert(store, 'user-1', SELF);
      const record = admitHubRecord();
      expect(inspectHubAuthRecordCompat(store, record, 'user-1')).toEqual({ ok: true });
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
      const blocked = inspectHubAuthRecordCompat(store, record, 'user-1');
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.code).toBe(KEYLOG_TYPE_UNSUPPORTED_BY_NODES);
        expect(blocked.minVersion).toBe(MIN_ROTATE_ROOT_KEEP_RECORD_VERSION);
        expect(blocked.allowForce).toBe(false);
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
      expect(inspectHubAuthRecordCompat(store, record, 'user-1')).toEqual({ ok: true });
    } finally {
      close();
    }
  });

  test('中继记录在空注册表（纯节点）上放行，hub-auth 记录仍然 fail-closed', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      seedCert(store, 'user-1', SELF);
      const relay = { relayMode: true } as const;
      expect(inspectHubAuthRecordCompat(store, relayRecord('set-relays'), 'user-1', relay)).toEqual(
        { ok: true }
      );
      expect(inspectHubAuthRecordCompat(store, relayRecord('meta-key'), 'user-1', relay)).toEqual({
        ok: true,
      });
      expect(
        inspectHubAuthRecordCompat(store, relayRecord('rename-node'), 'user-1', relay)
      ).toEqual({ ok: true });
      expect(inspectHubAuthRecordCompat(store, admitHubRecord(), 'user-1', relay).ok).toBe(false);
      expect(inspectHubAuthRecordCompat(store, rotateRootKeepRecord(), 'user-1', relay).ok).toBe(
        false
      );

      store.createNode({ id: PEER, userId: 'user-1', name: 'old', version: '1.1.22', now: 1 });
      seedCert(store, 'user-1', PEER);
      const blocked = inspectHubAuthRecordCompat(store, relayRecord('set-relays'), 'user-1');
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.minVersion).toBe('1.1.23');
        expect(blocked.nodes.map((n) => n.id)).toEqual([PEER]);
      }
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
      const relay = { relayMode: true } as const;
      const blocked = inspectHubAuthRecordCompat(store, rotateRootKeepRecord(), 'user-1', relay);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.minVersion).toBe(MIN_ROTATE_ROOT_KEEP_RECORD_VERSION);
        expect(blocked.allowForce).toBe(false);
        expect(blocked.nodes).toEqual([{ id: PEER, name: 'old', version: '1.1.15' }]);
      }

      seedPeer(store, PEER, 'ok', '1.1.16');
      expect(inspectHubAuthRecordCompat(store, rotateRootKeepRecord(), 'user-1', relay)).toEqual({
        ok: true,
      });
      const relaysOld = inspectHubAuthRecordCompat(
        store,
        relayRecord('set-relays'),
        'user-1',
        relay
      );
      expect(relaysOld.ok).toBe(false);
      seedPeer(store, PEER, 'ok', '1.1.23');
      expect(inspectHubAuthRecordCompat(store, relayRecord('set-relays'), 'user-1', relay)).toEqual(
        {
          ok: true,
        }
      );

      seedPeer(store, PEER, 'missing', null);
      const missing = inspectHubAuthRecordCompat(store, rotateRootKeepRecord(), 'user-1', relay);
      expect(missing.ok).toBe(false);
      if (!missing.ok) {
        expect(missing.nodes).toEqual([{ id: PEER, name: 'missing', version: null }]);
      }

      seedPeer(store, PEER, 'weird', 'ver-b');
      const unparseable = inspectHubAuthRecordCompat(
        store,
        rotateRootKeepRecord(),
        'user-1',
        relay
      );
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
      const blockedKeep = inspectHubAuthRecordCompat(store, keep, 'user-1');
      expect(blockedKeep.ok).toBe(false);
      if (!blockedKeep.ok) {
        expect(blockedKeep.code).toBe(KEYLOG_TYPE_UNSUPPORTED_BY_NODES);
        expect(blockedKeep.minVersion).toBe(MIN_ROTATE_ROOT_KEEP_RECORD_VERSION);
        expect(blockedKeep.allowForce).toBe(false);
        expect(blockedKeep.nodes).toEqual([{ id: SELF, name: SELF, version: null }]);
      }

      const admit = admitHubRecord();
      const blockedAdmit = inspectHubAuthRecordCompat(store, admit, 'user-1');
      expect(blockedAdmit.ok).toBe(false);
      if (!blockedAdmit.ok) {
        expect(blockedAdmit.allowForce).toBe(true);
        expect(blockedAdmit.nodes.map((n) => n.id)).toEqual([SELF]);
      }

      store.markCertRevoked(SELF, 9);
      expect(inspectHubAuthRecordCompat(store, keep, 'user-1')).toEqual({ ok: true });
      expect(inspectHubAuthRecordCompat(store, admit, 'user-1')).toEqual({ ok: true });

      store.createNode({
        id: PEER,
        userId: 'user-1',
        name: 'old-revoked-cert',
        version: '1.1.15',
        now: 1,
      });
      seedCert(store, 'user-1', PEER, 4);
      expect(inspectHubAuthRecordCompat(store, keep, 'user-1')).toEqual({ ok: true });
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
      const blocked = inspectHubAuthRecordCompat(store, rotateRootKeepRecord(), 'user-1');
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.nodes).toEqual([{ id: SELF, name: 'weird', version: 'ver-b' }]);
      }
    } finally {
      close();
    }
  });

  test('resolveMeshUserId uses the only user when present', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
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
      expect(resolveMeshUserId(store)).toBe('user-1');
      expect(resolveMeshUserId(store, { explicit: 'user-1' })).toBe('user-1');
    } finally {
      close();
    }
  });

  test('resolveMeshUserId prefers explicit then cert then unique node row', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store, 'user-1');
      store.create({
        id: 'user-2',
        username: 'bob',
        rootPublicKey: new Uint8Array(32).fill(2),
        rootEpoch: 1,
        kdfParamsJson: '{}',
        keyLogHeadSeq: 0,
        keyLogHeadHash: new Uint8Array(32),
        now: 1,
      });
      expect(resolveMeshUserId(store)).toBeNull();
      expect(resolveMeshUserId(store, { explicit: 'user-2' })).toBe('user-2');
      const nodeId = 'aa'.repeat(16);
      seedCert(store, 'user-1', nodeId);
      expect(resolveMeshUserId(store, { nodeId })).toBe('user-1');
      const nodeOnly = 'bb'.repeat(16);
      store.createNode({
        id: nodeOnly,
        userId: 'user-2',
        name: 'node-only',
        now: 1,
      });
      expect(resolveMeshUserId(store, { nodeId: nodeOnly })).toBe('user-2');
    } finally {
      close();
    }
  });
});
