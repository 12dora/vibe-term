import { describe, expect, test } from 'bun:test';
import {
  KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
  MIN_HUB_AUTH_RECORD_VERSION,
  MIN_ROTATE_ROOT_KEEP_RECORD_VERSION,
  buildAdmitHubPayload,
  buildKeyLogRecord,
  encodeKeyLogRecord,
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
      store.createNode({
        id: SELF,
        userId: 'user-1',
        name: 'writer',
        version: '1.1.13',
        now: 1,
      });
      store.createNode({
        id: PEER,
        userId: 'user-1',
        name: 'old',
        version: '1.1.12',
        now: 1,
      });
      const record = encodeKeyLogRecord(
        buildKeyLogRecord(genesisHead(), 0, {
          uid: 'user-1',
          type: 'admit-hub',
          payload: buildAdmitHubPayload({ hubNodeId: new Uint8Array(16).fill(1) }),
          signer: 'root',
          credential_id: null,
        })
      );
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
      store.createNode({
        id: SELF,
        userId: 'user-1',
        name: 'writer',
        version: '1.1.13_dev',
        now: 1,
      });
      const record = encodeKeyLogRecord(
        buildKeyLogRecord(genesisHead(), 0, {
          uid: 'user-1',
          type: 'admit-hub',
          payload: buildAdmitHubPayload({ hubNodeId: new Uint8Array(16).fill(2) }),
          signer: 'root',
          credential_id: null,
        })
      );
      expect(inspectHubAuthRecordCompat(store, record, 'user-1')).toEqual({ ok: true });
    } finally {
      close();
    }
  });

  test('blocks rotate-root-keep when a live node is old or unknown; revoked nodes do not block', () => {
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
      store.createNode({
        id: SELF,
        userId: 'user-1',
        name: 'writer',
        version: '1.1.16',
        now: 1,
      });
      store.createNode({
        id: PEER,
        userId: 'user-1',
        name: 'old',
        version: '1.1.15',
        now: 1,
      });
      store.createNode({
        id: OTHER,
        userId: 'user-1',
        name: 'revoked-old',
        status: 'revoked',
        version: '1.0.0',
        now: 1,
      });
      const record = encodeKeyLogRecord(
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
      store.createNode({
        id: SELF,
        userId: 'user-1',
        name: 'writer',
        version: '1.1.16_dev',
        now: 1,
      });
      const record = encodeKeyLogRecord(
        buildKeyLogRecord(genesisHead(), 0, {
          uid: 'user-1',
          type: 'rotate-root-keep',
          payload: encodeRotateRootKeepPayload({
            root_public_key: new Uint8Array(32).fill(2),
            kdf_params: generateKdfParams(),
            totp: null,
          }),
          signer: 'root',
          credential_id: null,
        })
      );
      expect(inspectHubAuthRecordCompat(store, record, 'user-1')).toEqual({ ok: true });
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
});
